// ======================================================
// marketplace_listing_health — métricas operacionais por anúncio
//
// Origem dos dados (Mercado Livre):
// - GET /items/:id → sale_fee_details, shipping, preços (promo), health parcial
// - GET /visits/items?ids= ou /items/visits?ids= → visitas (Bearer)
// - GET /items/:id/performance ou /health → qualidade / experiência
//
// Flags de ambiente (documentação):
// - ML_SYNC_SKIP_VISITS=1      → não chama API de visitas (visits fica null).
// - ML_SYNC_SKIP_PERFORMANCE=1 → não chama performance/health (qualidade/experiência ficam null).
// - ML_SYNC_HEALTH_LOG_SAMPLE=N → primeiros N itens do sync logam pipeline completo (default 5).
// - ML_FEE_PERSIST_LOG=1       → logs de qualidade da tarifa (ausência, % descartada, fallback amount÷preço).
// - ML_FEE_DEBUG=1             → [ML_FEE_DEBUG] por item (enrich → map → persist); tarifa só de listing_prices oficial.
// - ML_FEE_FINAL_DECISION=1 ou ML_FEE_FINAL_DECISION_EXT_ID=substring → [ML_FEE_FINAL_DECISION] persist + net_proceeds (auditoria).
// - ML_FEE_BASE_RULE=1 ou ML_FEE_BASE_RULE_EXT_ID=substring → [ML_FEE_BASE_RULE] base comissão = sale_price_effective × %.
// - ML_LISTING_PRICES_RAW_LOG=1 ou ML_LISTING_PRICES_RAW_LOG_EXT_ID=substring → [ML_LISTING_PRICES][raw_response_full] JSON completo do endpoint listing_prices.
// - ML_LISTING_PRICES_SHIPPING_AUDIT=1 ou ML_LISTING_PRICES_SHIPPING_AUDIT_EXT_ID=substring → auditoria frete + request/response listing_prices (também MLB6087353806 / MLB4473797855).
// - ML_PROMO_DETECT_LOG=1 ou ML_PROMO_DETECT_EXT_ID=substring → [ML_PROMO_DETECT] auditoria da detecção de promoção (grid).
// - ML_SHIPPING_RECONCILE_LOG=1 → [ML_SHIPPING_RECONCILE] promoção blob → colunas shipping (antes do strip).
// - ML_SHIPPING_RESOLVER_SYNC_LOG=1 ou ML_SHIPPING_RESOLVER_SYNC_EXT_IDS=MLB… → [ML_SHIPPING_RESOLVER_SYNC] inputs + elegibilidade do GAP no map health.
//
// Estratégia de persistência:
// - Sempre tenta upsert uma linha por anúncio após persistir marketplace_listings,
//   mesmo se visitas/performance falharem: fees, frete, promo e raw_json vêm do item.
// - Upsert: onConflict (user_id, marketplace, external_listing_id) — índice único na migration.
//
// Pendentes documentados:
// - conversion_rate: não exposto de forma estável no item.
// - orders_count: reservado; pedidos em listing_sales_metrics.
// - net_receivable: só se o item trouxer campo explícito em sale_fee_details / item.
// ======================================================

import {
  enrichItemWithListingPricesFees,
  fetchItemListingPerformance,
  fetchItemVisitsTotal,
  mlFeeDebugEnabled,
  mlListingFeeDebugEnabled,
  mlFeeValidateLogsEnabled,
  mlListingPricesShippingAuditLogEnabled,
  mlPriceValidateLogsEnabled,
} from "./mercadoLibreItemsApi.js";
import {
  coalesceListingPricesPersistedFeeAmount,
  coalesceMercadoLibreItemForMoneyExtract,
  extractListingPricesGrossReferenceAmount,
  extractMercadoLivreMarketplaceCostReductionFromListingPricesRow,
  extractMercadoLivreOfficialShippingFromListingPricesRow,
  extractNetReceivableExplicit,
  extractNetReceivableExplicitWithListingPricesRow,
  extractOfficialMercadoLibreListingPricesFee,
  extractPromotionPrice,
  extractMercadoLivreLogisticsSellerCost,
  extractSaleFee,
  extractShippingCost,
  mlFeeFinalDecisionLogEnabled,
  toFiniteFeeScalar,
  toFiniteNumber,
} from "./mlItemMoneyExtract.js";
import Decimal from "decimal.js";
import { resolveMercadoLivreSalePriceOfficial } from "../../../domain/pricing/mercadoLivreSalePriceOfficial.js";
import {
  ML_SHIPPING_COST_OFFICIAL_LABEL,
  mercadoLivreShippingCostOfficialToPersistBlob,
  resolveMercadoLivreShippingCostOfficial,
} from "../../../domain/pricing/mercadoLivreShippingCostOfficial.js";
import {
  guardPersistSaleFeeAmount,
  maybeLogFeeGrossVsPercentBase,
} from "../../../domain/pricing/pricingGuards.js";
import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "../../../domain/pricing/pricingInconsistencyLog.js";
import { buildMercadoLivreFeeBreakdown } from "./finance/mercadoLivreFeeBreakdown.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import {
  scheduleListingHealthFinancialSnapshot,
  SNAPSHOT_REASON,
  SNAPSHOT_SOURCE,
} from "./listingHealthFinancialSnapshot.js";
import { createListingSnapshot } from "./listingSnapshots.js";
import { resolveMarketplacePayout } from "./netProceeds/mercadoLivreNetProceedsCalculator.js";
import {
  buildHealthExistingSelectString,
  fetchExistingHealthRowCompat,
  formatHealthDbError,
  isPostgrestMissingColumnError,
  stripHealthRowToSchemaTier,
} from "./mlHealthSchemaCompat.js";
import { resolvePromotionEvidenceFromCoalescedItem } from "./mercadoLivrePromotionResolve.js";

/** @param {unknown} err */
export function formatPostgrestError(err) {
  if (!err || typeof err !== "object") return { message: String(err) };
  const o = /** @type {Record<string, unknown>} */ (err);
  return {
    code: o.code != null ? String(o.code) : undefined,
    message: o.message != null ? String(o.message) : undefined,
    details: o.details != null ? String(o.details) : undefined,
    hint: o.hint != null ? String(o.hint) : undefined,
  };
}

let syncMetrics = {
  upsertOk: 0,
  upsertFailed: 0,
  mapFailed: 0,
  skippedNoId: 0,
  sampleErrors: /** @type {ReturnType<typeof formatPostgrestError>[]} */ ([]),
};

let healthLogSeq = 0;

export function resetHealthSyncMetrics() {
  syncMetrics = {
    upsertOk: 0,
    upsertFailed: 0,
    mapFailed: 0,
    skippedNoId: 0,
    sampleErrors: [],
  };
  healthLogSeq = 0;
}

export function getHealthSyncMetrics() {
  return {
    upsert_ok: syncMetrics.upsertOk,
    upsert_failed: syncMetrics.upsertFailed,
    map_failed: syncMetrics.mapFailed,
    skipped_no_id: syncMetrics.skippedNoId,
    sample_errors: [...syncMetrics.sampleErrors],
  };
}

function pushSampleError(errPayload) {
  if (syncMetrics.sampleErrors.length >= 8) return;
  syncMetrics.sampleErrors.push(errPayload);
}

/** Monetário 2 casas para colunas numéricas do Postgrest. */
function roundMoney2(v) {
  const n = toFiniteNumber(v);
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}

/** ML_SHIPPING_RESOLVER_SYNC_LOG=1 ou ML_SHIPPING_RESOLVER_SYNC_EXT_IDS=MLB… */
function mlShippingResolverSyncDebugEnabled(extId) {
  if (process.env.ML_SHIPPING_RESOLVER_SYNC_LOG === "1") return true;
  const raw = process.env.ML_SHIPPING_RESOLVER_SYNC_EXT_IDS || "";
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const s = extId != null ? String(extId).trim().toUpperCase().replace(/\s/g, "") : "";
  if (s === "") return false;
  const norm = /^MLB\d+$/i.test(s) ? s : /^\d+$/.test(s.replace(/^MLB/i, "")) ? `MLB${s.replace(/^MLB/i, "")}` : s;
  return ids.includes(norm);
}

/**
 * % derivado de (amount ÷ preço efetivo) — teto mais restrito que % vindo do item/ML.
 */
const MAX_DERIVED_SALE_FEE_PERCENT = 25;

/**
 * % vindo de sale_fee_details do item (não listing_prices) — acima disso não persistimos (legado/ruído).
 */
const MAX_NON_OFFICIAL_SALE_FEE_PERCENT = 30;

/**
 * % explícito em GET listing_prices (fonte oficial) — ML pode reportar faixas acima do item genérico.
 */
const MAX_OFFICIAL_LISTING_PRICES_SALE_FEE_PERCENT = 45;

/** @deprecated use MAX_NON_OFFICIAL_SALE_FEE_PERCENT — mantido para merge/orders_fallback */
const MAX_TRUSTED_ML_SALE_FEE_PERCENT = MAX_NON_OFFICIAL_SALE_FEE_PERCENT;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isTrustedMercadoLivreSaleFeePercentValue(v) {
  const n = typeof v === "number" ? v : v != null ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return false;
  return n <= MAX_NON_OFFICIAL_SALE_FEE_PERCENT;
}

function mlFeePersistQualityLogEnabled() {
  return process.env.ML_FEE_PERSIST_LOG === "1" || mlFeeValidateLogsEnabled();
}

/**
 * Log único [ML_FEE_DEBUG] — ativar com ML_FEE_DEBUG=1.
 * @param {Record<string, unknown>} payload
 */
function emitMlFeeDebug(payload) {
  if (!mlFeeDebugEnabled()) return;
  console.info("[ML_FEE_DEBUG]", JSON.stringify(payload));
}

/**
 * Pós-upsert: valores calculados no map + linha lida do DB (equivalente ao SELECT pedido em diagnóstico).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {unknown} itemForHealth
 * @param {Record<string, unknown>} mappedRow
 * @param {Record<string, unknown>} rowForUpsert
 * @param {boolean} persistOk
 * @param {string | null | undefined} accessToken
 */
async function logMlFeeDebugAfterUpsert(
  supabase,
  userId,
  marketplace,
  itemId,
  itemForHealth,
  mappedRow,
  rowForUpsert,
  persistOk,
  accessToken
) {
  if (!mlFeeDebugEnabled()) return;
  const it =
    itemForHealth && typeof itemForHealth === "object"
      ? /** @type {Record<string, unknown>} */ (itemForHealth)
      : /** @type {Record<string, unknown>} */ ({});
  const lp = it._suse7_listing_prices_row_persist ?? null;
  const ex = it._suse7_listing_prices_row_excerpt ?? null;
  const off = lp
    ? extractOfficialMercadoLibreListingPricesFee(/** @type {Record<string, unknown>} */ (lp))
    : { percent: null, amount: null };
  const hasLp =
    lp != null &&
    ((off.amount != null && off.amount > 0) || (off.percent != null && off.percent > 0));
  const fr = it._suse7_fee_resolution && typeof it._suse7_fee_resolution === "object"
    ? /** @type {Record<string, unknown>} */ (it._suse7_fee_resolution)
    : {};
  const skipReason = !accessToken
    ? "missing_token"
    : fr.listing_prices_skip_reason != null
      ? String(fr.listing_prices_skip_reason)
      : hasLp
        ? null
        : "no_official_listing_prices_fee";

  let persistedAmt = rowForUpsert.sale_fee_amount ?? null;
  let persistedPct = rowForUpsert.sale_fee_percent ?? null;

  if (persistOk && supabase) {
    const { data: dbRow, error: readErr } = await supabase
      .from("marketplace_listing_health")
      .select("external_listing_id, sale_fee_amount, sale_fee_percent")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("external_listing_id", itemId)
      .maybeSingle();
    if (!readErr && dbRow && typeof dbRow === "object") {
      const dr = /** @type {Record<string, unknown>} */ (dbRow);
      persistedAmt = dr.sale_fee_amount ?? persistedAmt;
      persistedPct = dr.sale_fee_percent ?? persistedPct;
    }
  }

  emitMlFeeDebug({
    phase: "after_persist",
    listing_id: itemId,
    has_listing_prices: Boolean(hasLp),
    listing_prices_row: lp ?? ex ?? null,
    sale_fee_amount_calculated: mappedRow.sale_fee_amount ?? null,
    sale_fee_percent_calculated: mappedRow.sale_fee_percent ?? null,
    persisted_sale_fee_amount: persistedAmt,
    persisted_sale_fee_percent: persistedPct,
    skip_reason: skipReason,
    persist_ok: persistOk,
  });
}

/**
 * GET listing_prices exige site_id + price &gt; 0. O item do ML às vezes vem sem preço válido;
 * mescla colunas de `marketplace_listings` (+ raw_json) para não pular a tarifa oficial.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {Record<string, unknown>} item
 */
export async function mergeListingDbFieldsForListingPrices(supabase, userId, marketplace, item) {
  const extId = item?.id != null ? String(item.id).trim() : "";
  if (!extId || !supabase) return item;

  let siteId = item.site_id != null ? String(item.site_id).trim() : "";
  if (!siteId) {
    const m = extId.match(/^([A-Z]{3})\d/i);
    if (m) siteId = m[1].toUpperCase();
  }
  const priceN = toFiniteNumber(item.price);
  const needsPrice = priceN == null || priceN <= 0;
  const needsSiteOnItem = item.site_id == null || String(item.site_id).trim() === "";
  const needsCurrency = item.currency_id == null || String(item.currency_id).trim() === "";
  const needsLt = item.listing_type_id == null || String(item.listing_type_id).trim() === "";
  const needsCat = item.category_id == null || String(item.category_id).trim() === "";

  if (!needsPrice && !needsSiteOnItem && !needsCurrency && !needsLt && !needsCat) return item;
  if (!needsPrice && !needsCurrency && !needsLt && !needsCat && needsSiteOnItem && siteId) {
    return { ...item, site_id: siteId };
  }

  const { data: row, error } = await supabase
    .from("marketplace_listings")
    .select("price, currency_id, listing_type_id, raw_json")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("external_listing_id", extId)
    .maybeSingle();

  if (error || !row || typeof row !== "object") return item;

  const raw =
    row.raw_json && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
      ? /** @type {Record<string, unknown>} */ (row.raw_json)
      : {};
  const out = { ...item };
  if (needsSiteOnItem && siteId) {
    out.site_id = siteId;
  }
  if (needsPrice && row.price != null) {
    const p = toFiniteNumber(row.price);
    if (p != null && p > 0) out.price = p;
  }
  if (needsSiteOnItem && raw.site_id != null && String(raw.site_id).trim() !== "") {
    out.site_id = String(raw.site_id).trim();
  }
  if (needsCurrency && row.currency_id != null) out.currency_id = row.currency_id;
  else if (needsCurrency && raw.currency_id != null) out.currency_id = raw.currency_id;
  if (needsLt && row.listing_type_id != null) out.listing_type_id = row.listing_type_id;
  else if (needsLt && raw.listing_type_id != null) out.listing_type_id = raw.listing_type_id;
  if (needsCat && raw.category_id != null) out.category_id = raw.category_id;

  if (mlFeePersistQualityLogEnabled()) {
    console.info("[ML_FEE_PERSIST][merged_db_fields_for_listing_prices]", {
      external_listing_id: extId,
      merged_price: out.price ?? null,
      merged_site_id: out.site_id ?? null,
    });
  }
  if (mlFeeDebugEnabled()) {
    const p = toFiniteNumber(out.price);
    const siteOk = out.site_id != null && String(out.site_id).trim() !== "";
    const ltOk = out.listing_type_id != null && String(out.listing_type_id).trim() !== "";
    emitMlFeeDebug({
      phase: "merge_listing_db_fields",
      listing_id: extId,
      price_valid: p != null && p > 0,
      site_id_valid: siteOk,
      listing_type_id_valid: ltOk,
      merged_price: out.price ?? null,
      merged_site_id: out.site_id ?? null,
      merged_listing_type_id: out.listing_type_id ?? null,
      merged_category_id: out.category_id ?? null,
    });
  }
  return out;
}

/**
 * Log por item (uma linha JSON): `ML_SYNC_FEE_LINE_LOG=1` no backend.
 * @param {string} itemId
 * @param {unknown} itemForHealth
 * @param {Record<string, unknown>} rowForUpsert
 * @param {boolean} persistOk
 */
function emitMlFeeSyncLineLog(itemId, itemForHealth, rowForUpsert, persistOk) {
  if (process.env.ML_SYNC_FEE_LINE_LOG !== "1") return;
  const fr =
    itemForHealth && typeof itemForHealth === "object" && "_suse7_fee_resolution" in itemForHealth
      ? /** @type {Record<string, unknown>} */ (
          /** @type {Record<string, unknown>} */ (itemForHealth)._suse7_fee_resolution
        )
      : {};
  const rj = rowForUpsert.raw_json;
  const suse7 =
    rj && typeof rj === "object" && "suse7_fee_percent_resolution" in /** @type {Record<string, unknown>} */ (rj)
      ? /** @type {Record<string, unknown>} */ (
          /** @type {Record<string, unknown>} */ (rj).suse7_fee_percent_resolution
        )
      : null;
  const feeSource =
    suse7 && typeof suse7.fee_source === "string"
      ? suse7.fee_source
      : "none";
  const amt = toFiniteNumber(rowForUpsert.sale_fee_amount);
  console.info(
    "[ML_FEE_SYNC_LINE]",
    JSON.stringify({
      listing_id: itemId,
      fee_source: feeSource,
      listing_prices_gate: fr.gate_need_listing_prices === true,
      listing_prices_http_attempted: fr.listing_prices_http_attempted === true,
      listing_prices_skip_reason: fr.listing_prices_skip_reason ?? null,
      listing_prices_row_received: fr.listing_prices_row_received === true,
      fee_found_for_persist: amt != null && amt > 0,
      sale_fee_amount: rowForUpsert.sale_fee_amount ?? null,
      sale_fee_percent: rowForUpsert.sale_fee_percent ?? null,
      persist_ok: persistOk,
    })
  );
}

/**
 * PRIORIDADE 3: % quando não há percentual confiável da API — amount ÷ preço_venda_efetivo × 100.
 * Teto MAX_DERIVED_SALE_FEE_PERCENT (25%). Acima: descarta (denominador incoerente).
 * @param {number} saleFeeAmount
 * @param {number} effectiveSalePrice
 * @param {{ rejected_over_cap?: boolean }} [meta]
 */
function computeSaleFeePercentFallback(saleFeeAmount, effectiveSalePrice, meta) {
  const a = toFiniteNumber(saleFeeAmount);
  const p = toFiniteNumber(effectiveSalePrice);
  if (a == null || p == null || p <= 0 || a < 0) return null;
  try {
    const pct = new Decimal(String(a)).div(new Decimal(String(p))).times(100);
    const n = pct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    if (n > MAX_DERIVED_SALE_FEE_PERCENT) {
      if (meta && typeof meta === "object") meta.rejected_over_cap = true;
      return null;
    }
    return n;
  } catch {
    return null;
  }
}

/**
 * Sanitiza % para persistência; pode descartar % absurda e tentar derivar de amount.
 * @param {{
 *   extId: string;
 *   percentRaw: number | null;
 *   percentFromOfficialListingPrices: boolean;
 *   feePercentFallbackAlreadyUsed: boolean;
 *   saleFeeAmountNum: number | null;
 *   effectiveSalePrice: number | null;
 *   fallbackMeta: { rejected_over_cap?: boolean };
 * }} p
 * @returns {{ value: number | null; discarded_reason: string | null; fallback_used: boolean }}
 */
function resolvePersistedSaleFeePercent(p) {
  const {
    extId,
    percentRaw,
    percentFromOfficialListingPrices,
    feePercentFallbackAlreadyUsed,
    saleFeeAmountNum,
    effectiveSalePrice,
    fallbackMeta,
  } = p;

  let discardedReason = /** @type {string | null} */ (null);
  let pct = percentRaw != null && Number.isFinite(Number(percentRaw)) ? Number(percentRaw) : null;

  if (pct != null) {
    if (pct <= 0) {
      discardedReason = "non_positive_percent";
      pct = null;
    } else if (percentFromOfficialListingPrices) {
      if (pct > MAX_OFFICIAL_LISTING_PRICES_SALE_FEE_PERCENT) {
        discardedReason = "official_percent_over_cap";
        if (mlFeePersistQualityLogEnabled()) {
          console.warn("[ML_FEE_PERSIST][percent_discarded]", {
            external_listing_id: extId,
            reason: discardedReason,
            value: pct,
            cap: MAX_OFFICIAL_LISTING_PRICES_SALE_FEE_PERCENT,
          });
        }
        pct = null;
      }
    } else if (feePercentFallbackAlreadyUsed) {
      if (pct > MAX_DERIVED_SALE_FEE_PERCENT) {
        discardedReason = "derived_percent_over_cap";
        if (mlFeePersistQualityLogEnabled()) {
          console.warn("[ML_FEE_PERSIST][percent_discarded]", {
            external_listing_id: extId,
            reason: discardedReason,
            value: pct,
            cap: MAX_DERIVED_SALE_FEE_PERCENT,
          });
        }
        pct = null;
      }
    } else if (pct > MAX_NON_OFFICIAL_SALE_FEE_PERCENT) {
      discardedReason = "non_official_percent_over_cap";
      if (mlFeePersistQualityLogEnabled()) {
        console.warn("[ML_FEE_PERSIST][percent_discarded]", {
          external_listing_id: extId,
          reason: discardedReason,
          value: pct,
          cap: MAX_NON_OFFICIAL_SALE_FEE_PERCENT,
        });
      }
      pct = null;
    }
  }

  let fallbackUsed = false;
  if (pct == null && saleFeeAmountNum != null && saleFeeAmountNum > 0 && effectiveSalePrice != null) {
    const fb = computeSaleFeePercentFallback(saleFeeAmountNum, effectiveSalePrice, fallbackMeta);
    if (fb != null) {
      pct = fb;
      fallbackUsed = true;
      if (mlFeePersistQualityLogEnabled()) {
        console.info("[ML_FEE_PERSIST][percent_from_amount_div_price]", {
          external_listing_id: extId,
          sale_fee_amount: saleFeeAmountNum,
          effective_sale_price: effectiveSalePrice,
          computed_percent: fb,
        });
      }
    } else if (mlFeePersistQualityLogEnabled() && fallbackMeta.rejected_over_cap) {
      console.info("[ML_FEE_PERSIST][percent_fallback_rejected]", {
        external_listing_id: extId,
        sale_fee_amount: saleFeeAmountNum,
        effective_sale_price: effectiveSalePrice,
        max_derived_percent: MAX_DERIVED_SALE_FEE_PERCENT,
      });
    }
  }

  if (
    pct == null &&
    saleFeeAmountNum != null &&
    saleFeeAmountNum > 0 &&
    mlFeePersistQualityLogEnabled()
  ) {
    console.warn("[ML_FEE_PERSIST][no_percent_after_rules]", {
      external_listing_id: extId,
      sale_fee_amount: saleFeeAmountNum,
      prior_discard: discardedReason,
      had_fallback_path: feePercentFallbackAlreadyUsed || fallbackUsed,
    });
  }

  const value = pct != null ? roundMoney2(pct) : null;
  return { value, discarded_reason: discardedReason, fallback_used: fallbackUsed };
}

/**
 * Preço vigente no ML **sem promoção ativa**: `price` do item (o que o sync traz como atual),
 * depois `base_price`, depois `original_price`.
 * Evita `list_or_original` / tarifa presos em `original_price` antigo após mudança só no preço atual.
 * @param {Record<string, unknown>} src
 */
function resolveCurrentSalePriceBrlForPersistNoPromotion(src) {
  const p = toFiniteNumber(src.price);
  if (p != null && p > 0) return p;
  const b = toFiniteNumber(src.base_price);
  if (b != null && b > 0) return b;
  const o = toFiniteNumber(src.original_price);
  if (o != null && o > 0) return o;
  return null;
}

/**
 * Catálogo (valor riscado) quando há promoção e não há `listing_catalog_num` do núcleo de evidências.
 * @param {Record<string, unknown>} src
 */
function resolveListingCatalogBrlForPersistPromotionFallback(src) {
  const o = toFiniteNumber(src.original_price);
  if (o != null && o > 0) return o;
  const b = toFiniteNumber(src.base_price);
  if (b != null && b > 0) return b;
  const p = toFiniteNumber(src.price);
  if (p != null && p > 0) return p;
  return null;
}

/**
 * Promoção final: colunas planas de frete espelham `raw_json.suse7_shipping_cost` (saída do resolver).
 * Deve rodar **antes** de `stripHealthRowToSchemaTier`: com tier ≥ 2 o strip remove as chaves shipping v2;
 * se reconcile rodasse depois, não haveria `shipping_cost_source` no objeto e a promoção seria ignorada.
 *
 * @param {Record<string, unknown>} row
 * @param {0 | 1 | 2 | 3} schemaTier — mesmo tier do strip seguinte (`stripHealthRowToSchemaTier` remove shipping v2 quando tier ≥ 2)
 * @returns {Record<string, unknown>}
 */
function reconcileShippingOfficialColumnsFromResolver(row, schemaTier) {
  if (!row || typeof row !== "object") return row;
  const rj = row.raw_json;
  if (!rj || typeof rj !== "object") return row;
  const root = /** @type {Record<string, unknown>} */ (rj);
  const blob = root.suse7_shipping_cost;
  if (!blob || typeof blob !== "object") return row;
  const b = /** @type {Record<string, unknown>} */ (blob);

  const sourceRaw = b.source != null ? String(b.source).trim() : "";
  const sourceNorm = sourceRaw.toLowerCase();
  const amountRaw = b.amount_brl;
  const amountStr =
    amountRaw != null && String(amountRaw).trim() !== "" ? String(amountRaw).trim() : null;
  const num =
    amountStr != null
      ? Number(typeof amountRaw === "number" ? amountRaw : String(amountStr).replace(",", "."))
      : NaN;
  const resolved =
    sourceNorm !== "" &&
    sourceNorm !== "unresolved" &&
    amountStr != null &&
    Number.isFinite(num) &&
    num >= 0;

  /** Schema com colunas shipping v2 (migration aplicada): tier 0 ou 1. */
  const applyShippingV2 = schemaTier < 2;

  if (process.env.ML_SHIPPING_RECONCILE_LOG === "1") {
    console.info("[ML_SHIPPING_RECONCILE]", {
      external_listing_id: row.external_listing_id ?? null,
      schema_tier: schemaTier,
      apply_shipping_v2: applyShippingV2,
      blob_source: sourceRaw || null,
      blob_amount_brl: amountStr,
      resolved,
    });
  }

  if (resolved) {
    const amt = roundMoney2(num);
    if (Object.prototype.hasOwnProperty.call(row, "shipping_cost")) row.shipping_cost = amt;
    if (applyShippingV2) {
      row.shipping_cost_amount = amt;
      row.shipping_cost_source = sourceRaw;
      row.shipping_cost_currency = "BRL";
      const ctx = b.context;
      row.shipping_cost_context =
        ctx === "free_for_buyer" || ctx === "buyer_pays" ? ctx : null;
      row.shipping_cost_label =
        b.label != null && String(b.label).trim() !== ""
          ? String(b.label).trim()
          : ML_SHIPPING_COST_OFFICIAL_LABEL;
    }
    return row;
  }

  if (Object.prototype.hasOwnProperty.call(row, "shipping_cost")) row.shipping_cost = null;
  if (applyShippingV2) {
    row.shipping_cost_amount = null;
    row.shipping_cost_source = "unresolved";
    row.shipping_cost_currency = "BRL";
    row.shipping_cost_context = null;
    row.shipping_cost_label = ML_SHIPPING_COST_OFFICIAL_LABEL;
  }
  return row;
}

/**
 * Colunas de frete estimado (shipping_options/free) alinhadas ao blob `suse7_shipping_cost.auxiliary_*`.
 * @param {Record<string, unknown>} row
 * @param {0 | 1 | 2 | 3} schemaTier
 * @returns {Record<string, unknown>}
 */
function reconcileEstimatedSellerShippingFromBlob(row, schemaTier) {
  if (schemaTier >= 2) return row;
  const rj = row.raw_json;
  if (!rj || typeof rj !== "object") return row;
  const sc = /** @type {Record<string, unknown> | undefined} */ (
    /** @type {Record<string, unknown>} */ (rj).suse7_shipping_cost
  );
  if (!sc || typeof sc !== "object") return row;
  const auxRaw = sc.auxiliary_amount_brl;
  const num =
    auxRaw != null && String(auxRaw).trim() !== ""
      ? Number(String(auxRaw).replace(",", "."))
      : NaN;
  const has = Number.isFinite(num) && num >= 0;
  const srcDefault = "ml_shipping_options_free_simulation";
  if (!has) {
    row.estimated_seller_shipping_amount = null;
    row.estimated_seller_shipping_source = null;
    row.estimated_seller_shipping_currency = null;
    row.estimated_seller_shipping_synced_at = null;
    row.shipping_cost_auxiliary_brl = null;
    row.shipping_cost_auxiliary_source = null;
    return row;
  }
  const amt = roundMoney2(num);
  const src =
    sc.auxiliary_source != null && String(sc.auxiliary_source).trim() !== ""
      ? String(sc.auxiliary_source).trim()
      : srcDefault;
  const synced =
    row.api_last_seen_at != null && String(row.api_last_seen_at).trim() !== ""
      ? row.api_last_seen_at
      : row.updated_at != null && String(row.updated_at).trim() !== ""
        ? row.updated_at
        : new Date().toISOString();
  row.estimated_seller_shipping_amount = amt;
  row.estimated_seller_shipping_source = src;
  row.estimated_seller_shipping_currency = "BRL";
  row.estimated_seller_shipping_synced_at = synced;
  row.shipping_cost_auxiliary_brl = amt;
  row.shipping_cost_auxiliary_source = src;
  return row;
}

/**
 * @param {Record<string, unknown>} row — incoming (após spread)
 * @returns {boolean}
 */
function incomingShippingUnresolvedFromRow(row) {
  const s = row.shipping_cost_source != null ? String(row.shipping_cost_source).trim().toLowerCase() : "";
  return s === "unresolved";
}

/**
 * Não apagar taxa/repasse válido já gravado quando o sync atual falhou em extrair (ex.: listing_prices indisponível).
 * Não reaproveita % ou tarifa em R$ legadas não confiáveis (% &gt; teto ou linha só contaminada por % absurdo).
 * @param {Record<string, unknown>} incomingRow
 * @param {Record<string, unknown> | null} existing
 */
function mergePreserveMonetaryHealthColumns(incomingRow, existing) {
  if (!existing || typeof existing !== "object") return incomingRow;
  const out = { ...incomingRow };
  const incomingShipUnresolved = incomingShippingUnresolvedFromRow(out);
  const keys = /** @type {const} */ ([
    "sale_fee_amount",
    "sale_fee_percent",
    "shipping_cost",
    "shipping_cost_amount",
    "shipping_cost_currency",
    "shipping_cost_source",
    "shipping_cost_context",
    "shipping_cost_label",
    "net_receivable",
    "marketplace_sale_price_amount",
    "marketplace_payout_amount",
    "marketplace_payout_amount_brl",
    "marketplace_payout_currency",
    "marketplace_payout_synced_at",
    "promotion_price",
    "list_or_original_price_brl",
    "promotional_price_brl",
    "marketplace_cost_reduction_amount",
    "marketplace_cost_reduction_amount_brl",
    "estimated_seller_shipping_amount",
    "estimated_seller_shipping_source",
    "estimated_seller_shipping_currency",
    "estimated_seller_shipping_synced_at",
    "shipping_cost_auxiliary_brl",
    "shipping_cost_auxiliary_source",
  ]);
  const existingPct = existing.sale_fee_percent;
  const existingPctN =
    existingPct != null && existingPct !== ""
      ? typeof existingPct === "number"
        ? existingPct
        : Number(existingPct)
      : NaN;
  const existingPercentTrusted =
    Number.isFinite(existingPctN) && isTrustedMercadoLivreSaleFeePercentValue(existingPctN);

  for (const k of keys) {
    const nv = out[k];
    const ev = existing[k];
    const incomingEmpty = nv == null || nv === "";
    if (
      incomingShipUnresolved &&
      (k === "shipping_cost" ||
        k === "shipping_cost_amount" ||
        k === "shipping_cost_currency" ||
        k === "shipping_cost_source" ||
        k === "shipping_cost_context" ||
        k === "shipping_cost_label")
    ) {
      continue;
    }
    if (!incomingEmpty) continue;
    if (ev == null || ev === "") continue;
    if (k === "marketplace_payout_currency") {
      const s = String(ev).trim();
      if (s !== "") out[k] = ev;
      continue;
    }
    if (k === "marketplace_payout_synced_at") {
      const s = String(ev).trim();
      if (s !== "") out[k] = ev;
      continue;
    }
    if (
      k === "estimated_seller_shipping_currency" ||
      k === "estimated_seller_shipping_source" ||
      k === "shipping_cost_auxiliary_source"
    ) {
      if (String(ev).trim() !== "") out[k] = ev;
      continue;
    }
    if (k === "estimated_seller_shipping_synced_at") {
      const s = String(ev).trim();
      if (s !== "") out[k] = ev;
      continue;
    }
    const e = typeof ev === "number" ? ev : Number(ev);
    if (!Number.isFinite(e)) continue;
    if (
      k === "shipping_cost" ||
      k === "shipping_cost_amount" ||
      k === "estimated_seller_shipping_amount" ||
      k === "shipping_cost_auxiliary_brl" ||
      k === "net_receivable"
    ) {
      if (e >= 0) out[k] = ev;
      continue;
    }
    if (k === "shipping_cost_currency" || k === "shipping_cost_source" || k === "shipping_cost_label") {
      if (String(ev).trim() !== "") out[k] = ev;
      continue;
    }
    if (k === "shipping_cost_context") {
      const s = String(ev).trim();
      if (s === "free_for_buyer" || s === "buyer_pays") out[k] = ev;
      continue;
    }
    if (k === "sale_fee_percent") {
      if (isTrustedMercadoLivreSaleFeePercentValue(e)) out[k] = ev;
      continue;
    }
    if (k === "sale_fee_amount") {
      const pctMissing = existingPct == null || existingPct === "";
      if (e > 0 && (pctMissing || existingPercentTrusted)) out[k] = ev;
      continue;
    }
    if (k === "promotion_price" || k === "promotional_price_brl") {
      // Regra de segurança: não preservar promoção antiga quando o sync atual não confirmou evidência.
      continue;
    }
    if (
      k === "marketplace_payout_amount" ||
      k === "marketplace_payout_amount_brl" ||
      k === "marketplace_sale_price_amount"
    ) {
      if (e >= 0) out[k] = ev;
      continue;
    }
    if (k === "marketplace_cost_reduction_amount" || k === "marketplace_cost_reduction_amount_brl") {
      if (e >= 0) out[k] = ev;
      continue;
    }
    if (e > 0) out[k] = ev;
  }
  if (
    (out.marketplace_payout_source == null || String(out.marketplace_payout_source).trim() === "") &&
    existing.marketplace_payout_source != null &&
    String(existing.marketplace_payout_source).trim() !== ""
  ) {
    out.marketplace_payout_source = existing.marketplace_payout_source;
  }
  if (
    (out.marketplace_cost_reduction_source == null ||
      String(out.marketplace_cost_reduction_source).trim() === "") &&
    existing.marketplace_cost_reduction_source != null &&
    String(existing.marketplace_cost_reduction_source).trim() !== ""
  ) {
    out.marketplace_cost_reduction_source = existing.marketplace_cost_reduction_source;
  }
  if (
    (out.marketplace_cost_reduction_label == null ||
      String(out.marketplace_cost_reduction_label).trim() === "") &&
    existing.marketplace_cost_reduction_label != null &&
    String(existing.marketplace_cost_reduction_label).trim() !== ""
  ) {
    out.marketplace_cost_reduction_label = existing.marketplace_cost_reduction_label;
  }
  return out;
}

/**
 * Não apagar snapshots úteis em `raw_json.raw_payloads` quando o sync atual não os reproduziu
 * (ex.: listing_prices falhou mas já havia linha gravada; orders_metrics já calculado).
 * @param {Record<string, unknown>} incomingRow
 * @param {Record<string, unknown> | null} existing
 */
function mergePreserveHealthRawPayloads(incomingRow, existing) {
  if (!existing || typeof existing !== "object") return incomingRow;
  const exrj = existing.raw_json;
  if (!exrj || typeof exrj !== "object") return incomingRow;
  const exRoot = /** @type {Record<string, unknown>} */ (exrj);
  const exPay =
    exRoot.raw_payloads && typeof exRoot.raw_payloads === "object"
      ? /** @type {Record<string, unknown>} */ (exRoot.raw_payloads)
      : null;
  if (!exPay) return incomingRow;

  const irj = incomingRow.raw_json;
  if (!irj || typeof irj !== "object") return incomingRow;
  const irjRec = /** @type {Record<string, unknown>} */ (irj);
  const inPay =
    irjRec.raw_payloads && typeof irjRec.raw_payloads === "object"
      ? /** @type {Record<string, unknown>} */ (irjRec.raw_payloads)
      : {};

  let changed = false;
  const nextPay = { ...inPay };

  if (nextPay.orders_metrics == null && exPay.orders_metrics != null) {
    nextPay.orders_metrics = exPay.orders_metrics;
    changed = true;
  }
  if (nextPay.listing_prices_row == null && exPay.listing_prices_row != null) {
    nextPay.listing_prices_row = exPay.listing_prices_row;
    changed = true;
  }
  if (nextPay.shipping_options_free == null && exPay.shipping_options_free != null) {
    nextPay.shipping_options_free = exPay.shipping_options_free;
    changed = true;
  }
  if (nextPay.sale_price_snapshot == null && exPay.sale_price_snapshot != null) {
    nextPay.sale_price_snapshot = exPay.sale_price_snapshot;
    changed = true;
  }
  if (
    nextPay.listing_prices_http_response == null &&
    exPay.listing_prices_http_response != null
  ) {
    nextPay.listing_prices_http_response = exPay.listing_prices_http_response;
    changed = true;
  }
  if (
    nextPay.seller_promotion_from_sale_price == null &&
    exPay.seller_promotion_from_sale_price != null
  ) {
    nextPay.seller_promotion_from_sale_price = exPay.seller_promotion_from_sale_price;
    changed = true;
  }
  if (nextPay.listing_prices_shipping_audit == null && exPay.listing_prices_shipping_audit != null) {
    nextPay.listing_prices_shipping_audit = exPay.listing_prices_shipping_audit;
    changed = true;
  }

  if (!changed) return incomingRow;
  return {
    ...incomingRow,
    raw_json: {
      ...irjRec,
      raw_payloads: nextPay,
    },
  };
}

/**
 * Logs detalhados [ML_HEALTH_SYNC_EXISTING][*] para um anúncio (ex.: MLB4473596489).
 * @param {unknown} item
 */
function mlHealthSyncExistingTraceEnabled(item) {
  if (process.env.ML_HEALTH_SYNC_EXISTING_LOG === "1") return true;
  const id =
    item && typeof item === "object" && item != null && "id" in item
      ? String(/** @type {Record<string, unknown>} */ (item).id ?? "")
      : "";
  const needle = String(process.env.ML_HEALTH_SYNC_EXISTING_LOG_EXT_ID ?? "4473596489").trim();
  return needle !== "" && id.includes(needle);
}

/** @param {unknown} v @param {number} max */
function jsonSnippetForLog(v, max = 720) {
  try {
    const s = JSON.stringify(v);
    if (s == null) return null;
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return "[json_error]";
  }
}

/**
 * Garante JSON serializável para jsonb (undefined → omitido/null, bigint → string).
 * @param {unknown} v
 */
function safeJsonClone(v) {
  try {
    return JSON.parse(
      JSON.stringify(v, (_k, val) => {
        if (val === undefined) return null;
        if (typeof val === "bigint") return val.toString();
        return val;
      })
    );
  } catch (e) {
    return { _json_clone_error: e?.message ? String(e.message) : "unknown" };
  }
}

/** @param {unknown} v */
function toInt(v) {
  const n = toFiniteNumber(v);
  if (n == null) return null;
  return Math.trunc(n);
}

function extractShippingTags(item) {
  const sh = item?.shipping;
  if (!sh || typeof sh !== "object") return null;
  const tags = sh.tags;
  if (tags == null) return null;
  if (Array.isArray(tags)) return tags;
  return tags;
}

function itemExcerptForRaw(item) {
  if (!item || typeof item !== "object") return null;
  const sh = item.shipping;
  return {
    id: item.id != null ? String(item.id) : null,
    title: item.title != null ? String(item.title).slice(0, 120) : null,
    price: item.price,
    base_price: item.base_price ?? null,
    original_price: item.original_price ?? null,
    currency_id: item.currency_id,
    sale_fee_amount: item.sale_fee_amount ?? null,
    sale_fee_details: item.sale_fee_details ?? null,
    shipping:
      sh && typeof sh === "object"
        ? {
            mode: sh.mode,
            logistic_type: sh.logistic_type,
            cost:
              sh.cost ??
              sh.list_cost ??
              sh.default_cost ??
              sh.paid_cost ??
              sh.seller_cost ??
              sh.consolidated_price ??
              sh.base_cost,
            free_shipping: sh.free_shipping,
          }
        : null,
  };
}

/**
 * Auditoria de GET listing_prices para frete oficial (request + response + linha escolhida).
 * @param {unknown} item
 * @param {Record<string, unknown> | null} listingPricesPersist
 * @param {Record<string, unknown> | null} listingPricesExcerpt
 * @param {Record<string, unknown> | null | undefined} listingPricesHttpRaw
 */
function buildListingPricesShippingAuditForRaw(item, listingPricesPersist, listingPricesExcerpt, listingPricesHttpRaw) {
  if (!mlListingPricesShippingAuditLogEnabled(item)) return null;
  return {
    captured_at_iso: new Date().toISOString(),
    request_url: listingPricesHttpRaw?.request_url ?? null,
    attempt: listingPricesHttpRaw?.attempt ?? null,
    omit_shipping_params: listingPricesHttpRaw?.omit_shipping_params ?? null,
    http_status: listingPricesHttpRaw?.http_status ?? null,
    http_ok: listingPricesHttpRaw?.http_ok ?? null,
    skip_reason: listingPricesHttpRaw?.skip_reason ?? null,
    response_body: listingPricesHttpRaw?.response_body ?? null,
    selected_row_full: listingPricesPersist ?? listingPricesExcerpt ?? null,
  };
}

/**
 * Monta linha a partir do item ML + respostas auxiliares (visits / performance).
 */
export function mapMlToListingHealthRow(userId, item, marketplace, nowIso, aux = {}) {
  const extId = item?.id != null ? String(item.id) : null;
  if (!extId) throw new Error("Item sem id para health");

  const src = coalesceMercadoLibreItemForMoneyExtract(/** @type {Record<string, unknown>} */ (item));
  /** % oficial: listing_prices / sale_fee_details (sem ×); se ausente, fallback controlado amount÷preço efetivo. */
  const feeNoDerive = extractSaleFee(src, {
    listing: /** @type {Record<string, unknown>} */ (item),
    skipDeepExtract: true,
    deriveFromPercent: false,
  });
  const feeDerived = extractSaleFee(src, {
    listing: /** @type {Record<string, unknown>} */ (item),
    skipDeepExtract: true,
    deriveFromPercent: true,
  });
  const visits = aux.visitsTotal != null ? toInt(aux.visitsTotal) : null;
  const perf = aux.performance && typeof aux.performance === "object" ? aux.performance : null;

  let qualityScore = null;
  let qualityStatus = null;
  let qualitySub = null;
  let expStatus = null;
  let expSub = null;
  let messages = null;

  if (perf) {
    const h = perf.health;
    let healthScore = null;
    if (typeof h === "number" && Number.isFinite(h)) healthScore = h;
    else if (h && typeof h === "object") {
      healthScore = toFiniteNumber(h.health ?? h.score);
    }
    qualityScore = toFiniteNumber(perf.score ?? healthScore ?? perf.level_score);
    qualityStatus =
      perf.level != null
        ? String(perf.level)
        : perf.status != null
          ? String(perf.status)
          : perf.level_wording != null
            ? String(perf.level_wording)
            : null;
    qualitySub =
      perf.substatus != null
        ? String(perf.substatus)
        : perf.level_id != null
          ? String(perf.level_id)
          : null;
    const buy =
      perf.buying_experience ??
      perf.buyer_experience ??
      perf.shopping_experience ??
      perf.purchase_experience ??
      perf.experience;
    if (buy && typeof buy === "object") {
      expStatus =
        buy.status != null ? String(buy.status) : buy.level != null ? String(buy.level) : null;
      expSub = buy.substatus != null ? String(buy.substatus) : null;
    }
    if (Array.isArray(perf.messages)) messages = perf.messages;
    else if (Array.isArray(perf.alerts)) messages = perf.alerts;
    else if (Array.isArray(perf.goals)) messages = perf.goals;
  }

  const sh = src?.shipping;
  const shipMode = sh?.mode != null ? String(sh.mode) : null;
  const shipLog = sh?.logistic_type != null ? String(sh.logistic_type) : null;

  const feeRes =
    item && typeof item === "object" && "_suse7_fee_resolution" in item
      ? /** @type {Record<string, unknown>} */ (item)._suse7_fee_resolution
      : null;

  const listingPricesPersist =
    item && typeof item === "object" && "_suse7_listing_prices_row_persist" in item
      ? /** @type {Record<string, unknown> | null} */ (
          /** @type {Record<string, unknown>} */ (item)._suse7_listing_prices_row_persist
        )
      : null;
  const listingPricesExcerpt =
    item && typeof item === "object" && "_suse7_listing_prices_row_excerpt" in item
      ? /** @type {Record<string, unknown>} */ (item)._suse7_listing_prices_row_excerpt
      : null;

  const listingPricesForRaw = listingPricesPersist ?? listingPricesExcerpt;

  const listingPricesHttpRaw =
    item && typeof item === "object" && "_suse7_listing_prices_http_raw" in item
      ? /** @type {Record<string, unknown> | null | undefined} */ (
          /** @type {Record<string, unknown>} */ (item)._suse7_listing_prices_http_raw
        )
      : null;

  const officialLp = listingPricesPersist
    ? extractOfficialMercadoLibreListingPricesFee(
        /** @type {Record<string, unknown>} */ (listingPricesPersist)
      )
    : { percent: null, amount: null };

  const saleSnap =
    item && typeof item === "object" && "_suse7_sale_price_snapshot" in item
      ? /** @type {Record<string, unknown> | null | undefined} */ (
          /** @type {Record<string, unknown>} */ (item)._suse7_sale_price_snapshot
        )
      : null;
  const promoEvidence = resolvePromotionEvidenceFromCoalescedItem(src, saleSnap);
  const promoPriceForFee = promoEvidence.promotion_price;
  const hasActivePromotionForFeeHint = promoEvidence.promotion_active;

  const listPriceForFee = promoEvidence.promotion_active
    ? (promoEvidence.listing_catalog_num ?? resolveListingCatalogBrlForPersistPromotionFallback(src))
    : resolveCurrentSalePriceBrlForPersistNoPromotion(src);

  /** Núcleo oficial domain/pricing — base única para listing_prices, % derivado e repasse. */
  const pricingOfficialForFees = resolveMercadoLivreSalePriceOfficial({
    marketplace,
    listing_id: extId,
    user_id: userId != null ? String(userId) : null,
    marketplace_account_id: null,
    listing_price: listPriceForFee,
    promotion_price: promoPriceForFee,
    has_active_promotion_hint: hasActivePromotionForFeeHint,
    context: "ml_map_listing_health_row",
  });

  let effectiveSalePriceForFee;
  if (pricingOfficialForFees.sale_price_effective != null) {
    effectiveSalePriceForFee = Number(pricingOfficialForFees.sale_price_effective);
  } else {
    effectiveSalePriceForFee =
      promoPriceForFee != null && listPriceForFee != null
        ? promoPriceForFee
        : listPriceForFee;
    if (listPriceForFee != null && listPriceForFee > 0) {
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.PRICING_FALLBACK_APPLIED, {
        marketplace,
        listing_id: extId,
        user_id: userId != null ? String(userId) : null,
        context: "ml_map_listing_health_effective_fallback",
        message: "Resolver oficial sem sale_price_effective — fallback promo/listing na linha health",
      });
    }
  }
  const hasActivePromotionForFee = pricingOfficialForFees.has_valid_promotion;
  const fallbackMeta = /** @type {{ rejected_over_cap?: boolean }} */ ({});

  const listingPricesRowPersistedFee =
    listingPricesPersist != null && typeof listingPricesPersist === "object"
      ? coalesceListingPricesPersistedFeeAmount(/** @type {Record<string, unknown>} */ (listingPricesPersist))
      : null;
  const listingPricesGrossRef =
    listingPricesPersist != null && typeof listingPricesPersist === "object"
      ? extractListingPricesGrossReferenceAmount(/** @type {Record<string, unknown>} */ (listingPricesPersist))
      : null;

  const listingPricesHasSaleFeeDetails =
    listingPricesPersist != null &&
    typeof listingPricesPersist === "object" &&
    (() => {
      const sfd = /** @type {Record<string, unknown>} */ (listingPricesPersist).sale_fee_details;
      if (sfd == null || sfd === "") return false;
      if (Array.isArray(sfd)) return sfd.length > 0;
      if (typeof sfd === "object") return Object.keys(sfd).length > 0;
      return typeof sfd === "string";
    })();

  const hasOfficialListingPricesFee =
    listingPricesPersist != null &&
    ((officialLp.amount != null && officialLp.amount > 0) ||
      (officialLp.percent != null && officialLp.percent > 0) ||
      (listingPricesRowPersistedFee != null && listingPricesRowPersistedFee > 0) ||
      listingPricesHasSaleFeeDetails);

  /** @type {"listing_prices" | "none"} */
  let feeSource = "none";

  /** @type {number | null} */
  let saleFeeAmountNum = null;
  /** @type {number | null} */
  let saleFeePercentNum = null;
  /** @type {number | null} */
  let feePercentFinal = null;
  /** @type {boolean} */
  let feePercentFallbackUsed = false;

  /** @type {string | null} */
  let feeDiscardedReason = null;

  if (hasOfficialListingPricesFee) {
    feeSource = "listing_prices";
    /** Prioridade: taxa efetiva (selling_fee) quando ML envia bruto + efetivo na mesma linha. */
    if (listingPricesRowPersistedFee != null && listingPricesRowPersistedFee > 0) {
      saleFeeAmountNum = listingPricesRowPersistedFee;
    } else if (
      listingPricesPersist != null &&
      typeof listingPricesPersist === "object"
    ) {
      const lp = /** @type {Record<string, unknown>} */ (listingPricesPersist);
      const sellDirect = toFiniteFeeScalar(
        lp.selling_fee ?? lp.selling_fee_amount ?? lp.net_selling_fee ?? lp.final_selling_fee
      );
      if (sellDirect != null && sellDirect > 0) {
        saleFeeAmountNum = sellDirect;
      } else if (officialLp.amount != null && officialLp.amount > 0) {
        saleFeeAmountNum = officialLp.amount;
      } else if (
        officialLp.percent != null &&
        officialLp.percent > 0 &&
        effectiveSalePriceForFee != null &&
        effectiveSalePriceForFee > 0
      ) {
        saleFeeAmountNum = new Decimal(String(effectiveSalePriceForFee))
          .times(new Decimal(String(officialLp.percent)))
          .div(100)
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
          .toNumber();
      }
    } else if (officialLp.amount != null && officialLp.amount > 0) {
      saleFeeAmountNum = officialLp.amount;
    } else if (
      officialLp.percent != null &&
      officialLp.percent > 0 &&
      effectiveSalePriceForFee != null &&
      effectiveSalePriceForFee > 0
    ) {
      saleFeeAmountNum = new Decimal(String(effectiveSalePriceForFee))
        .times(new Decimal(String(officialLp.percent)))
        .div(100)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toNumber();
    }
    if (officialLp.percent != null && officialLp.percent > 0) {
      saleFeePercentNum = officialLp.percent;
    } else if (saleFeeAmountNum != null && saleFeeAmountNum > 0 && effectiveSalePriceForFee != null) {
      saleFeePercentNum = computeSaleFeePercentFallback(
        saleFeeAmountNum,
        effectiveSalePriceForFee,
        fallbackMeta
      );
    }

    const percentFromOfficialListingPrices =
      officialLp.percent != null && officialLp.percent > 0;

    const feeResolved = resolvePersistedSaleFeePercent({
      extId,
      percentRaw: saleFeePercentNum,
      percentFromOfficialListingPrices,
      feePercentFallbackAlreadyUsed: false,
      saleFeeAmountNum,
      effectiveSalePrice: effectiveSalePriceForFee,
      fallbackMeta,
    });
    feePercentFinal = feeResolved.value;
    feePercentFallbackUsed = feeResolved.fallback_used;
    feeDiscardedReason = feeResolved.discarded_reason;
  } else {
    /** Sem taxa oficial parseável de listing_prices: não inventar % nem usar fallback de repasse. */
    feeSource = "none";
  }

  if (
    feeSource === "listing_prices" &&
    officialLp.percent != null &&
    officialLp.percent > 0 &&
    effectiveSalePriceForFee != null &&
    effectiveSalePriceForFee > 0 &&
    listingPricesGrossRef != null &&
    listingPricesGrossRef > 0
  ) {
    maybeLogFeeGrossVsPercentBase({
      marketplace,
      listing_id: extId,
      user_id: userId != null ? String(userId) : null,
      sale_price_effective: effectiveSalePriceForFee,
      fee_percent: officialLp.percent,
      gross_reference_from_row: listingPricesGrossRef,
      context: "ml_health_listing_prices_row",
    });
  }

  if (saleFeeAmountNum != null) {
    const feeGuard = guardPersistSaleFeeAmount(saleFeeAmountNum);
    if (!feeGuard.ok) {
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.NEGATIVE_SALE_FEE_BLOCKED, {
        marketplace,
        listing_id: extId,
        user_id: userId != null ? String(userId) : null,
        context: "ml_health_persist",
        fee_attempted: saleFeeAmountNum,
        message: "sale_fee_amount negativo — valor descartado na persistência",
      });
      saleFeeAmountNum = null;
    }
  }

  const sellerPromoFromSalePrice =
    item && typeof item === "object" && "_suse7_seller_promotion_details" in item
      ? /** @type {Record<string, unknown> | null | undefined} */ (
          /** @type {Record<string, unknown>} */ (item)._suse7_seller_promotion_details
        )
      : null;

  const listOrBrl = promoEvidence.promotion_active
    ? (promoEvidence.listing_catalog_num ?? resolveListingCatalogBrlForPersistPromotionFallback(src))
    : resolveCurrentSalePriceBrlForPersistNoPromotion(src);
  const promoBrl = promoEvidence.promotion_active ? promoEvidence.promotion_price : null;

  const shipFromMlItem = extractShippingCost(src);
  const shipFromOptionsFree =
    item && typeof item === "object" && "_suse7_shipping_options_free_amount" in item
      ? toFiniteNumber(/** @type {Record<string, unknown>} */ (item)._suse7_shipping_options_free_amount)
      : null;
  const sfdForShip =
    (listingPricesPersist && typeof listingPricesPersist === "object"
      ? /** @type {Record<string, unknown>} */ (listingPricesPersist).sale_fee_details
      : null) ??
    (listingPricesExcerpt && typeof listingPricesExcerpt === "object"
      ? /** @type {Record<string, unknown>} */ (listingPricesExcerpt).sale_fee_details
      : null) ??
    src?.sale_fee_details;
  /** Um único parse de logística por linha — alimenta `fromOfficialMl` e evita log/parse duplicado. */
  const fromSaleFeeDetailsShip = extractMercadoLivreLogisticsSellerCost(sfdForShip, {
    listing_id: extId,
    logContext: "ml_map_listing_health_row",
  });
  const fromListingPricesOfficialShip =
    listingPricesPersist && typeof listingPricesPersist === "object"
      ? extractMercadoLivreOfficialShippingFromListingPricesRow(
          /** @type {Record<string, unknown>} */ (listingPricesPersist),
          {
            listing_id: extId,
            logisticsSellerCostPrecalculated: fromSaleFeeDetailsShip,
          }
        )
      : listingPricesExcerpt && typeof listingPricesExcerpt === "object"
        ? extractMercadoLivreOfficialShippingFromListingPricesRow(
            /** @type {Record<string, unknown>} */ (listingPricesExcerpt),
            { listing_id: extId }
          )
        : null;

  const netReceivableExplicitVal = (() => {
    const n = extractNetReceivableExplicitWithListingPricesRow(src, listingPricesPersist);
    return n != null ? roundMoney2(n) : null;
  })();

  const shippingGapEligibilityReason = (() => {
    if (effectiveSalePriceForFee == null || !Number.isFinite(effectiveSalePriceForFee) || effectiveSalePriceForFee <= 0) {
      return "missing_effective_sale_price";
    }
    if (saleFeeAmountNum == null || !Number.isFinite(saleFeeAmountNum) || saleFeeAmountNum <= 0) {
      return "missing_sale_fee_amount";
    }
    if (netReceivableExplicitVal == null) return "missing_net_receivable_explicit";
    if (netReceivableExplicitVal < 0) return "net_receivable_negative";
    return "ok";
  })();

  if (mlShippingResolverSyncDebugEnabled(extId)) {
    console.info("[ML_SHIPPING_RESOLVER_SYNC]", {
      external_listing_id: extId,
      effective_sale_price_for_fee: effectiveSalePriceForFee,
      sale_fee_amount: saleFeeAmountNum,
      fixed_fee_amount: 0,
      net_receivable_explicit: netReceivableExplicitVal,
      shipping_gap_eligibility: shippingGapEligibilityReason,
      listing_prices_row_present: listingPricesPersist != null,
      from_listing_prices_logistics: fromListingPricesOfficialShip,
      from_sale_fee_details_logistics: fromSaleFeeDetailsShip,
      from_ml_item_shipping: shipFromMlItem,
      shipping_options_free_auxiliary: shipFromOptionsFree,
    });
  }

  const freeShipRaw =
    sh && typeof sh === "object" && "free_shipping" in sh ? sh.free_shipping : null;

  const gapForShippingResolver =
    effectiveSalePriceForFee != null &&
    Number.isFinite(effectiveSalePriceForFee) &&
    effectiveSalePriceForFee > 0 &&
    saleFeeAmountNum != null &&
    saleFeeAmountNum > 0 &&
    netReceivableExplicitVal != null &&
    netReceivableExplicitVal >= 0
      ? {
          sale: new Decimal(String(effectiveSalePriceForFee)),
          fee: new Decimal(String(saleFeeAmountNum)),
          net: new Decimal(String(netReceivableExplicitVal)),
        }
      : null;

  const officialShippingResolved = resolveMercadoLivreShippingCostOfficial({
    listing_id: extId,
    logContext: "ml_map_listing_health_row",
    shipping_logistic_type: shipLog,
    listing_status:
      src?.status != null && String(src.status).trim() !== "" ? String(src.status).trim() : null,
    available_quantity: toFiniteNumber(src?.available_quantity),
    fromShippingOptionsFree: shipFromOptionsFree,
    fromOfficialMl: fromListingPricesOfficialShip,
    fromSaleFeeDetails: fromSaleFeeDetailsShip,
    fromMlItem: shipFromMlItem,
    fromHealth: null,
    gap: gapForShippingResolver,
    free_shipping: freeShipRaw === true ? true : freeShipRaw === false ? false : null,
  });

  if (mlShippingResolverSyncDebugEnabled(extId)) {
    console.info("[ML_SHIPPING_RESOLVER_SYNC_RESULT]", {
      external_listing_id: extId,
      gap_built: gapForShippingResolver != null,
      shipping_cost_source: officialShippingResolved.source,
      amount_brl: officialShippingResolved.amount_brl,
      decision_source: officialShippingResolved.decision_source,
    });
  }

  const shipCost =
    officialShippingResolved.amount_brl != null ? Number(officialShippingResolved.amount_brl) : null;
  const netReceivableOfficialCalc =
    effectiveSalePriceForFee != null &&
    Number.isFinite(effectiveSalePriceForFee) &&
    effectiveSalePriceForFee > 0 &&
    saleFeeAmountNum != null &&
    Number.isFinite(saleFeeAmountNum) &&
    saleFeeAmountNum >= 0 &&
    shipCost != null &&
    Number.isFinite(shipCost) &&
    shipCost >= 0
      ? (() => {
          const payout = resolveMarketplacePayout({
            listing_price: effectiveSalePriceForFee,
            sale_fee_amount: saleFeeAmountNum,
            shipping_cost_amount: shipCost,
            fixed_fee_amount: 0,
          });
          return payout != null ? roundMoney2(payout.toNumber()) : null;
        })()
      : null;
  /** “Você recebe”: em fallback de frete auxiliar, evita repasse explícito incoerente sem frete. */
  const shippingFromAuxiliaryFallback =
    officialShippingResolved.source === "ml_shipping_options_free_simulation";
  const shippingSuspiciousRejected =
    officialShippingResolved.source === "unresolved" &&
    officialShippingResolved.decision_source === "suspicious_low_shipping_rejected";
  const netReceivableVal =
    shippingSuspiciousRejected
      ? netReceivableOfficialCalc
      : shippingFromAuxiliaryFallback && netReceivableOfficialCalc != null
      ? netReceivableOfficialCalc
      : netReceivableExplicitVal ?? netReceivableOfficialCalc;

  const costReductionMeta = extractMercadoLivreMarketplaceCostReductionFromListingPricesRow(
    listingPricesPersist && typeof listingPricesPersist === "object"
      ? /** @type {Record<string, unknown>} */ (listingPricesPersist)
      : null
  );
  const costReductionAmt =
    costReductionMeta.amount_brl != null && Number.isFinite(Number(costReductionMeta.amount_brl))
      ? roundMoney2(Number(costReductionMeta.amount_brl))
      : null;
  const marketplacePayoutSource =
    shippingSuspiciousRejected
      ? netReceivableOfficialCalc != null
        ? "estimated"
        : "unresolved"
      : shippingFromAuxiliaryFallback && netReceivableOfficialCalc != null
      ? "estimated"
      : netReceivableExplicitVal != null
        ? "ml_official"
        : netReceivableOfficialCalc != null
          ? "estimated"
          : "unresolved";

  const raw = {
    item_excerpt: itemExcerptForRaw(src),
    visits_api: aux.visitsRaw ?? null,
    performance_api: perf,
    sale_fee_details: src?.sale_fee_details ?? null,
    shipping_snapshot: sh && typeof sh === "object" ? { mode: sh.mode, logistic_type: sh.logistic_type } : null,
    fee_resolution: feeRes && typeof feeRes === "object" ? feeRes : null,
    /** Auditoria oficial de preço (Raio-X / repasse) — espelha domain/pricing. */
    suse7_pricing_resolution: {
      listing_price_brl: pricingOfficialForFees.listing_price,
      promotion_price_brl: pricingOfficialForFees.promotion_price,
      promotion_price_observed_brl: pricingOfficialForFees.promotion_price_observed,
      promotion_active: pricingOfficialForFees.has_valid_promotion,
      promotion_evidence_source: promoEvidence.source,
      sale_price_effective_brl: pricingOfficialForFees.sale_price_effective,
      has_valid_promotion: pricingOfficialForFees.has_valid_promotion,
      decision_source: pricingOfficialForFees.decision_source,
      inconsistency_codes: pricingOfficialForFees.inconsistency_codes,
    },
    /** Custo “Custo de envio do Mercado Livre” — valor ML + contexto comprador (fonte Suse7). */
    suse7_shipping_cost: mercadoLivreShippingCostOfficialToPersistBlob(officialShippingResolved),
    suse7_marketplace_payout: {
      amount_brl: netReceivableVal,
      source: marketplacePayoutSource,
      decision_source:
        shippingSuspiciousRejected
          ? netReceivableOfficialCalc != null
            ? "sale_minus_fee_minus_shipping_suspicious_low_rejected"
            : "unresolved_suspicious_low_shipping_rejected"
          : shippingFromAuxiliaryFallback && netReceivableOfficialCalc != null
          ? "sale_minus_fee_minus_shipping_auxiliary_fallback"
          : netReceivableExplicitVal != null
          ? "ml_extractNetReceivableExplicit"
          : netReceivableOfficialCalc != null
            ? "sale_minus_fee_minus_shipping"
            : "unresolved",
      explicit_item_net_receivable: netReceivableExplicitVal,
      estimated_components: netReceivableOfficialCalc,
    },
    suse7_marketplace_cost_reduction: {
      amount_brl: costReductionMeta.amount_brl,
      gross_fee_brl: costReductionMeta.gross_fee_brl,
      net_fee_brl: costReductionMeta.net_fee_brl,
      source: costReductionMeta.source,
    },
    suse7_fee_percent_resolution: {
      fee_source: feeSource,
      primary_source:
        feeSource === "listing_prices" ? "listing_prices_sale_fee_details" : null,
      amount_div_sale_price_fallback_used: feePercentFallbackUsed,
      percent_discarded_reason: feeDiscardedReason,
      final_percent: feePercentFinal,
      fallback_percent_rejected_over_sanity_cap: Boolean(
        fallbackMeta.rejected_over_cap
      ),
      max_derived_percent_cap: MAX_DERIVED_SALE_FEE_PERCENT,
      max_non_official_percent_cap: MAX_NON_OFFICIAL_SALE_FEE_PERCENT,
      max_official_listing_prices_percent_cap: MAX_OFFICIAL_LISTING_PRICES_SALE_FEE_PERCENT,
      listing_prices_row_present: listingPricesPersist != null,
      api_listing_prices_doc:
        "GET /sites/{site_id}/listing_prices?price&listing_type_id&category_id&currency_id&logistic_type&shipping_mode",
      listing_prices_fee_audit:
        listingPricesPersist != null && typeof listingPricesPersist === "object"
          ? {
              sale_fee_amount_row:
                /** @type {Record<string, unknown>} */ (listingPricesPersist).sale_fee_amount ?? null,
              selling_fee_row:
                /** @type {Record<string, unknown>} */ (listingPricesPersist).selling_fee ??
                /** @type {Record<string, unknown>} */ (listingPricesPersist).selling_fee_amount ??
                null,
              gross_reference_amount: listingPricesGrossRef,
              persisted_final_from_row_coalesce: listingPricesRowPersistedFee,
              implied_row_discount_amount:
                listingPricesGrossRef != null &&
                listingPricesRowPersistedFee != null &&
                listingPricesGrossRef > listingPricesRowPersistedFee + 0.001
                  ? roundMoney2(listingPricesGrossRef - listingPricesRowPersistedFee)
                  : null,
              official_extract_amount: officialLp.amount,
              official_extract_percent: officialLp.percent,
            }
          : null,
    },
    raw_payloads: {
      listing_prices_row: listingPricesForRaw,
      listing_prices_shipping_audit: buildListingPricesShippingAuditForRaw(
        item,
        listingPricesPersist,
        listingPricesExcerpt,
        listingPricesHttpRaw
      ),
      listing_prices_http_response:
        listingPricesHttpRaw && typeof listingPricesHttpRaw === "object"
          ? listingPricesHttpRaw
          : null,
      shipping_options_free:
        item && typeof item === "object" && "_suse7_shipping_options_free_persist" in item
          ? /** @type {Record<string, unknown>} */ (item)._suse7_shipping_options_free_persist
          : null,
      sale_price_snapshot:
        saleSnap && typeof saleSnap === "object"
          ? {
              amount: saleSnap.amount ?? null,
              regular_amount: saleSnap.regular_amount ?? null,
              currency_id: saleSnap.currency_id ?? null,
              price_id: saleSnap.price_id ?? null,
              reference_date: saleSnap.reference_date ?? null,
              promotion_id: saleSnap.promotion_id ?? null,
              promotion_type: saleSnap.promotion_type ?? null,
              metadata: saleSnap.metadata ?? null,
              context_used: saleSnap.context_used ?? "channel_marketplace",
            }
          : null,
      seller_promotion_from_sale_price:
        sellerPromoFromSalePrice && typeof sellerPromoFromSalePrice === "object"
          ? sellerPromoFromSalePrice
          : null,
    },
  };

  const promoPxLegacyExtract = extractPromotionPrice(src);

  if (mlListingFeeDebugEnabled(/** @type {Record<string, unknown>} */ (item))) {
    const sfd = src.sale_fee_details;
    /** @param {unknown} v */
    const snippet = (v) => {
      try {
        const s = JSON.stringify(v);
        return s.length > 900 ? `${s.slice(0, 900)}…` : s;
      } catch {
        return v != null ? String(v) : "null";
      }
    };
    const excerpt = raw.item_excerpt;
    const hasItemExcerpt =
      excerpt != null && typeof excerpt === "object" && !Array.isArray(excerpt);
    const feeEmptyDespiteSfd =
      sfd != null &&
      sfd !== "" &&
      typeof sfd !== "boolean" &&
      !(typeof sfd === "object" && !Array.isArray(sfd) && Object.keys(sfd).length === 0) &&
      !(Array.isArray(sfd) && sfd.length === 0) &&
      feeDerived.amount == null &&
      feeNoDerive.percent == null;

    console.info("[ML_MAP_HEALTH_ROW][paths]", {
      external_listing_id: extId,
      item_id: extId,
      has_health_raw_json: true,
      has_item_excerpt: hasItemExcerpt,
      has_sale_fee_details_root: Boolean(item && typeof item === "object" && item.sale_fee_details),
      has_sale_fee_details_coalesced: Boolean(src.sale_fee_details),
      sale_fee_path_resolved: hasItemExcerpt &&
        excerpt &&
        typeof excerpt === "object" &&
        "sale_fee_details" in excerpt &&
        excerpt.sale_fee_details != null
        ? "item → coalesce → item_excerpt.sale_fee_details"
        : item && typeof item === "object" && item.sale_fee_details
          ? "item.sale_fee_details"
          : "item → coalesce (merged)",
      sale_fee_details_type:
        sfd == null ? null : Array.isArray(sfd) ? "array" : typeof sfd,
      sale_fee_details_snippet: sfd != null ? snippet(sfd) : null,
      extract_sale_fee_amount_resolved: feeDerived.amount,
      extract_sale_fee_percent_resolved: feePercentFinal,
      fee_percent_fallback_used: feePercentFallbackUsed,
      official_listing_prices_percent: officialLp.percent,
      official_listing_prices_amount: officialLp.amount,
      fee_parse_empty_despite_blob: feeEmptyDespiteSfd,
      extract_sale_fee_no_derive: feeNoDerive,
      extract_sale_fee_derived_amount: feeDerived,
      shipping_cost_resolved: shipCost,
      promotion_price_resolved: promoBrl,
      promotion_price_item_extract_only: promoPxLegacyExtract,
      shipping_path_resolved:
        sh && typeof sh === "object" ? "item.shipping (coalesced)" : null,
      shipping_keys:
        sh && typeof sh === "object" ? Object.keys(/** @type {Record<string, unknown>} */ (sh)) : [],
    });
  }

  const auxBrlRaw = officialShippingResolved.auxiliary_amount_brl;
  const auxNumForEst =
    auxBrlRaw != null && String(auxBrlRaw).trim() !== ""
      ? Number(String(auxBrlRaw).replace(",", "."))
      : null;
  const hasEstimatedSellerShipping =
    auxNumForEst != null && Number.isFinite(auxNumForEst) && auxNumForEst >= 0;
  const estimatedSellerShippingSource =
    officialShippingResolved.auxiliary_source != null &&
    String(officialShippingResolved.auxiliary_source).trim() !== ""
      ? String(officialShippingResolved.auxiliary_source).trim()
      : "ml_shipping_options_free_simulation";

  /** @type {Record<string, unknown>} */
  const row = {
    user_id: userId,
    marketplace,
    external_listing_id: extId,
    visits,
    orders_count: null,
    conversion_rate: null,
    sale_fee_percent: feePercentFinal,
    sale_fee_amount: saleFeeAmountNum != null ? roundMoney2(saleFeeAmountNum) : null,
    shipping_cost: shipCost != null ? roundMoney2(shipCost) : null,
    shipping_cost_amount: shipCost != null ? roundMoney2(shipCost) : null,
    shipping_cost_currency: "BRL",
    shipping_cost_source: officialShippingResolved.source ?? null,
    shipping_cost_context: officialShippingResolved.context ?? null,
    shipping_cost_label: officialShippingResolved.label ?? ML_SHIPPING_COST_OFFICIAL_LABEL,
    estimated_seller_shipping_amount: hasEstimatedSellerShipping ? roundMoney2(auxNumForEst) : null,
    estimated_seller_shipping_source: hasEstimatedSellerShipping ? estimatedSellerShippingSource : null,
    estimated_seller_shipping_currency: hasEstimatedSellerShipping ? "BRL" : null,
    estimated_seller_shipping_synced_at: hasEstimatedSellerShipping ? nowIso : null,
    shipping_cost_auxiliary_brl: hasEstimatedSellerShipping ? roundMoney2(auxNumForEst) : null,
    shipping_cost_auxiliary_source: hasEstimatedSellerShipping ? estimatedSellerShippingSource : null,
    net_receivable: netReceivableVal,
    marketplace_payout_amount: netReceivableVal != null ? roundMoney2(Number(netReceivableVal)) : null,
    marketplace_payout_amount_brl: netReceivableVal != null ? roundMoney2(Number(netReceivableVal)) : null,
    marketplace_sale_price_amount:
      effectiveSalePriceForFee != null &&
      Number.isFinite(effectiveSalePriceForFee) &&
      effectiveSalePriceForFee > 0
        ? roundMoney2(effectiveSalePriceForFee)
        : null,
    marketplace_payout_currency:
      src.currency_id != null && String(src.currency_id).trim() !== ""
        ? String(src.currency_id).trim()
        : "BRL",
    marketplace_payout_synced_at: netReceivableVal != null ? nowIso : null,
    marketplace_payout_source: marketplacePayoutSource,
    marketplace_cost_reduction_amount: costReductionAmt,
    marketplace_cost_reduction_amount_brl: costReductionAmt,
    marketplace_cost_reduction_source: costReductionMeta.source,
    marketplace_cost_reduction_label:
      costReductionAmt != null && costReductionAmt > 0
        ? "Redução aplicada pelo marketplace"
        : null,
    list_or_original_price_brl: listOrBrl != null ? roundMoney2(listOrBrl) : null,
    promotional_price_brl: promoBrl != null ? roundMoney2(promoBrl) : null,
    promotion_price: promoBrl != null ? roundMoney2(promoBrl) : null,
    listing_quality_score: qualityScore,
    listing_quality_status: qualityStatus,
    listing_quality_substatus: qualitySub,
    experience_status: expStatus,
    experience_substatus: expSub,
    shipping_mode: shipMode,
    shipping_logistic_type: shipLog,
    shipping_tags: extractShippingTags(item),
    marketplace_messages: messages,
    raw_json: raw,
    api_imported_at: nowIso,
    api_last_seen_at: nowIso,
    updated_at: nowIso,
  };

  if (mlPriceValidateLogsEnabled()) {
    console.info("[ML_PRICE_VALIDATE][pre_persist_prices]", {
      external_listing_id: extId,
      list_or_original_price_brl: row.list_or_original_price_brl,
      promotional_price_brl: row.promotional_price_brl,
      promotion_price: row.promotion_price,
    });
  }

  if (mlFeePersistQualityLogEnabled() && (saleFeeAmountNum == null || saleFeeAmountNum <= 0)) {
    console.warn("[ML_FEE_PERSIST][no_sale_fee_amount]", {
      external_listing_id: extId,
      listing_prices_row_present: listingPricesPersist != null,
    });
  }

  if (mlFeeFinalDecisionLogEnabled(extId)) {
    /** @type {Record<string, unknown> | null} */
    let motorSnapshot = null;
    try {
      if (
        effectiveSalePriceForFee != null &&
        effectiveSalePriceForFee > 0 &&
        feePercentFinal != null &&
        feePercentFinal > 0
      ) {
        const apiFeeNum =
          listingPricesRowPersistedFee != null
            ? listingPricesRowPersistedFee
            : saleFeeAmountNum != null
              ? saleFeeAmountNum
              : null;
        const b = buildMercadoLivreFeeBreakdown({
          sale_price_effective: effectiveSalePriceForFee,
          marketplace_fee_percent: feePercentFinal,
          marketplace_fee_amount_api: apiFeeNum,
          shipping_cost_marketplace:
            officialShippingResolved.amount_brl != null ? Number(officialShippingResolved.amount_brl) : 0,
          fixed_fee_amount: 0,
          listing_id: extId,
          sale_fee_label: null,
          audit_listing_price: listPriceForFee,
          audit_promotion_price: hasActivePromotionForFee ? promoPriceForFee : null,
        });
        motorSnapshot = /** @type {Record<string, unknown>} */ (b);
      }
    } catch (e) {
      motorSnapshot = { error: e instanceof Error ? e.message : String(e) };
    }
    console.info(
      "[ML_FEE_FINAL_DECISION]",
      JSON.stringify({
        stage: "mapMlToListingHealthRow",
        listing_id: extId,
        listing_price: toFiniteNumber(src.price),
        promotion_price: extractPromotionPrice(src),
        sale_price_effective: effectiveSalePriceForFee,
        sale_fee_percent_resolved: feePercentFinal,
        listing_prices_fee_audit: raw.suse7_fee_percent_resolution?.listing_prices_fee_audit ?? null,
        gross_fee_amount: motorSnapshot && "gross_fee_amount" in motorSnapshot ? motorSnapshot.gross_fee_amount : null,
        api_fee_amount: motorSnapshot && "sale_fee_amount_api" in motorSnapshot ? motorSnapshot.sale_fee_amount_api : null,
        marketplace_fee_discount_amount:
          motorSnapshot && "marketplace_fee_discount_amount" in motorSnapshot
            ? motorSnapshot.marketplace_fee_discount_amount
            : null,
        final_sale_fee_amount_motor:
          motorSnapshot && "sale_fee_amount" in motorSnapshot ? motorSnapshot.sale_fee_amount : null,
        fee_source: feeSource,
        calculation_confidence:
          motorSnapshot && "calculation_confidence" in motorSnapshot
            ? motorSnapshot.calculation_confidence
            : null,
        persisted_sale_fee_amount: row.sale_fee_amount,
        sale_fee_percent_column: row.sale_fee_percent,
      })
    );
  }

  return row;
}

/**
 * @param {Record<string, unknown>} row
 */
function prepareRowForUpsert(row) {
  const prepared = { ...row };
  prepared.raw_json = safeJsonClone(prepared.raw_json);
  if (prepared.shipping_tags != null) prepared.shipping_tags = safeJsonClone(prepared.shipping_tags);
  if (prepared.marketplace_messages != null) {
    prepared.marketplace_messages = safeJsonClone(prepared.marketplace_messages);
  }
  return prepared;
}

/**
 * @param {Record<string, unknown>} row
 */
function healthPayloadSummaryForLog(row) {
  return {
    external_listing_id: row.external_listing_id ?? null,
    sale_fee_amount: row.sale_fee_amount ?? null,
    sale_fee_percent: row.sale_fee_percent ?? null,
    shipping_cost_amount: row.shipping_cost_amount ?? row.shipping_cost ?? null,
    net_receivable: row.net_receivable ?? null,
    promotion_price: row.promotion_price ?? null,
    list_or_original_price_brl: row.list_or_original_price_brl ?? null,
    promotional_price_brl: row.promotional_price_brl ?? null,
  };
}

/**
 * Upsert health; não lança — incrementa métricas e loga.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {object} [opts]
 * @param {boolean} [opts.healthSyncExistingPass] — refresh só health (sync-listings para anúncios já existentes).
 * @param {{ reason: string; source: string }} [opts.financialSnapshot] — motivo/origem do snapshot financeiro (padrão: health_sync / ml_health_sync).
 * @returns {Promise<boolean>} true se gravou com sucesso
 */
export async function upsertMarketplaceListingHealthFromMlItem(supabase, userId, item, opts = {}) {
  const log = opts.log || (() => {});
  const accessToken = opts.accessToken;
  const nowIso = opts.nowIso || new Date().toISOString();
  const marketplace = opts.marketplace || ML_MARKETPLACE_SLUG;
  const healthSyncExistingPass = opts.healthSyncExistingPass === true;
  const traceExisting = healthSyncExistingPass && mlHealthSyncExistingTraceEnabled(item);

  const skipAux = opts.skipAuxiliaryApi === true;
  const skipVisits = process.env.ML_SYNC_SKIP_VISITS === "1" || skipAux;
  const skipPerf = process.env.ML_SYNC_SKIP_PERFORMANCE === "1" || skipAux;
  const sampleLimit = Math.max(0, parseInt(process.env.ML_SYNC_HEALTH_LOG_SAMPLE || "5", 10) || 5);

  healthLogSeq += 1;
  const seq = healthLogSeq;
  const verbose = seq <= sampleLimit;

  let visitsTotal = null;
  let visitsRaw = null;
  let performance = null;

  const itemId = item?.id != null ? String(item.id) : null;
  if (!itemId) {
    syncMetrics.skippedNoId += 1;
    console.warn("[ml/health] skipped_no_id", { seq, reason: "item.id ausente" });
    return false;
  }

  const traceHealth =
    typeof item === "object" && item != null
      ? mlListingFeeDebugEnabled(/** @type {Record<string, unknown>} */ (item))
      : mlListingFeeDebugEnabled(/** @type {Record<string, unknown>} */ ({ id: itemId }));

  const itemRec =
    typeof item === "object" && item != null
      ? /** @type {Record<string, unknown>} */ (item)
      : /** @type {Record<string, unknown>} */ ({});

  if (traceExisting) {
    console.info("[ML_HEALTH_SYNC_EXISTING][item_before_enrich]", {
      external_listing_id: itemId,
      health_sync_existing_pass: true,
      price: itemRec.price ?? null,
      base_price: itemRec.base_price ?? null,
      sale_fee_amount: itemRec.sale_fee_amount ?? null,
      has_sale_fee_details: Boolean(itemRec.sale_fee_details),
      sale_fee_details_snippet: jsonSnippetForLog(itemRec.sale_fee_details),
      extract_sale_fee_no_derive: extractSaleFee(itemRec, {
        deriveFromPercent: false,
        listing: itemRec,
      }),
    });
  }

  const itemMerged =
    accessToken && supabase && typeof item === "object"
      ? await mergeListingDbFieldsForListingPrices(supabase, userId, marketplace, itemRec)
      : itemRec;

  const itemForHealth =
    accessToken && typeof itemMerged === "object"
      ? await enrichItemWithListingPricesFees(
          accessToken,
          /** @type {Record<string, unknown>} */ (itemMerged),
          { healthSync: true }
        )
      : item;

  if (mlFeeDebugEnabled()) {
    const it =
      itemForHealth && typeof itemForHealth === "object"
        ? /** @type {Record<string, unknown>} */ (itemForHealth)
        : /** @type {Record<string, unknown>} */ ({});
    const lp = it._suse7_listing_prices_row_persist ?? null;
    const ex = it._suse7_listing_prices_row_excerpt ?? null;
    const off = lp
      ? extractOfficialMercadoLibreListingPricesFee(/** @type {Record<string, unknown>} */ (lp))
      : { percent: null, amount: null };
    const hasLp =
      lp != null &&
      ((off.amount != null && off.amount > 0) || (off.percent != null && off.percent > 0));
    const fr = it._suse7_fee_resolution && typeof it._suse7_fee_resolution === "object"
      ? /** @type {Record<string, unknown>} */ (it._suse7_fee_resolution)
      : {};
    const skipReason = !accessToken
      ? "missing_token"
      : (fr.listing_prices_skip_reason != null ? String(fr.listing_prices_skip_reason) : hasLp
          ? null
          : "no_official_listing_prices_fee");
    emitMlFeeDebug({
      phase: "after_enrich",
      listing_id: itemId,
      has_listing_prices: Boolean(hasLp),
      listing_prices_row: lp ?? ex ?? null,
      sale_fee_amount_calculated: off.amount,
      sale_fee_percent_calculated: off.percent,
      persisted_sale_fee_amount: null,
      persisted_sale_fee_percent: null,
      skip_reason: skipReason,
    });
  }

  if (traceExisting) {
    const it1 = /** @type {Record<string, unknown>} */ (
      itemForHealth && typeof itemForHealth === "object" ? itemForHealth : {}
    );
    const feeBefore = extractSaleFee(itemRec, {
      deriveFromPercent: false,
      listing: itemRec,
    });
    const feeAfter = extractSaleFee(it1, { deriveFromPercent: false, listing: it1 });
    console.info("[ML_HEALTH_SYNC_EXISTING][item_enriched]", {
      external_listing_id: itemId,
      had_access_token: Boolean(accessToken),
      sale_fee_amount_after: it1.sale_fee_amount ?? null,
      has_sale_fee_details_after: Boolean(it1.sale_fee_details),
      sale_fee_details_snippet: jsonSnippetForLog(it1.sale_fee_details),
      extract_sale_fee_no_derive_after: feeAfter,
      fee_amount_changed:
        JSON.stringify(itemRec.sale_fee_amount ?? null) !== JSON.stringify(it1.sale_fee_amount ?? null),
      listing_prices_likely_fetched:
        feeAfter.amount != null &&
        feeAfter.amount > 0 &&
        (feeBefore.amount == null || feeBefore.amount <= 0),
    });
  }

  if (traceHealth) {
    console.info("[ML_PERSIST_HEALTH_ROW][after_enrich]", {
      external_listing_id: itemId,
      had_access_token: Boolean(accessToken),
      item_sale_fee_amount: itemForHealth?.sale_fee_amount ?? null,
      item_has_sale_fee_details:
        itemForHealth && typeof itemForHealth === "object"
          ? Boolean(/** @type {Record<string, unknown>} */ (itemForHealth).sale_fee_details)
          : false,
      extract_shipping_cost_preview:
        itemForHealth && typeof itemForHealth === "object"
          ? extractShippingCost(/** @type {Record<string, unknown>} */ (itemForHealth))
          : null,
    });
  }

  if (verbose) {
    console.log("[ml/health] start", { external_listing_id: itemId, seq, skipVisits, skipPerf });
  }

  if (accessToken && !skipVisits) {
    try {
      const v = await fetchItemVisitsTotal(accessToken, itemId);
      visitsTotal = v.total;
      visitsRaw = v.raw;
      if (verbose) {
        console.log("[ml/health] visits_result", {
          external_listing_id: itemId,
          visits: visitsTotal,
          had_raw: visitsRaw != null,
        });
      }
    } catch (e) {
      log("health_visits_skip", { itemId, message: e?.message });
      if (verbose) {
        console.warn("[ml/health] visits_error", { external_listing_id: itemId, message: e?.message });
      }
    }
  } else if (verbose) {
    console.log("[ml/health] visits_skipped", {
      external_listing_id: itemId,
      reason: !accessToken ? "no_access_token" : "ML_SYNC_SKIP_VISITS=1",
    });
  }

  if (accessToken && !skipPerf) {
    try {
      performance = await fetchItemListingPerformance(accessToken, itemId);
      if (verbose) {
        console.log("[ml/health] performance_result", {
          external_listing_id: itemId,
          listing_quality_score:
            performance && typeof performance === "object"
              ? performance.score ?? performance.health ?? null
              : null,
          experience_status:
            performance && typeof performance === "object"
              ? performance.buying_experience?.status ??
                performance.shopping_experience?.status ??
                null
              : null,
          had_payload: performance != null,
        });
      }
    } catch (e) {
      log("health_performance_skip", { itemId, message: e?.message });
      if (verbose) {
        console.warn("[ml/health] performance_error", { external_listing_id: itemId, message: e?.message });
      }
    }
  } else if (verbose) {
    console.log("[ml/health] performance_skipped", {
      external_listing_id: itemId,
      reason: !accessToken ? "no_access_token" : "ML_SYNC_SKIP_PERFORMANCE=1",
    });
  }

  let row;
  try {
    row = mapMlToListingHealthRow(
      userId,
      /** @type {Record<string, unknown>} */ (itemForHealth),
      marketplace,
      nowIso,
      {
        visitsTotal,
        visitsRaw,
        performance,
      }
    );
  } catch (e) {
    syncMetrics.mapFailed += 1;
    const msg = e?.message || String(e);
    log("health_map_failed", { itemId, message: msg });
    console.error("[ml/health] map_failed", { external_listing_id: itemId, message: msg });
    pushSampleError({ stage: "map", external_listing_id: itemId, ...formatPostgrestError(e) });
    return false;
  }

  const cleanRow = prepareRowForUpsert(row);

  const existingFetch = await fetchExistingHealthRowCompat(
    supabase,
    userId,
    marketplace,
    String(cleanRow.external_listing_id)
  );
  if (existingFetch.error && !existingFetch.data) {
    syncMetrics.upsertFailed += 1;
    const fe = formatHealthDbError(existingFetch.error);
    log("health_existing_select_failed", { external_listing_id: itemId, ...fe });
    console.error("[ml/health] existing_select_fatal", { external_listing_id: itemId, ...fe });
    pushSampleError({ stage: "existing_select", external_listing_id: itemId, ...fe });
    return false;
  }

  const existingRec = existingFetch.data;
  /** @type {0 | 1 | 2 | 3} */
  let schemaTier = existingFetch.schemaTier;

  let rowForUpsert = mergePreserveMonetaryHealthColumns(cleanRow, existingRec);
  rowForUpsert = mergePreserveHealthRawPayloads(
    /** @type {Record<string, unknown>} */ (rowForUpsert),
    existingRec
  );
  rowForUpsert = reconcileShippingOfficialColumnsFromResolver(
    /** @type {Record<string, unknown>} */ (rowForUpsert),
    schemaTier
  );
  rowForUpsert = reconcileEstimatedSellerShippingFromBlob(
    /** @type {Record<string, unknown>} */ (rowForUpsert),
    schemaTier
  );
  rowForUpsert = stripHealthRowToSchemaTier(
    /** @type {Record<string, unknown>} */ (rowForUpsert),
    schemaTier
  );

  if (mlFeeValidateLogsEnabled()) {
    const rj = rowForUpsert.raw_json;
    const pay =
      rj && typeof rj === "object" && "raw_payloads" in /** @type {Record<string, unknown>} */ (rj)
        ? /** @type {Record<string, unknown>} */ (
            /** @type {Record<string, unknown>} */ (rj).raw_payloads
          )
        : null;
    console.info("[ML_FEE_VALIDATE][pre_upsert_health_payload]", {
      external_listing_id: rowForUpsert.external_listing_id,
      had_existing_row: existingRec != null,
      sale_fee_amount: rowForUpsert.sale_fee_amount,
      sale_fee_percent: rowForUpsert.sale_fee_percent,
      shipping_cost: rowForUpsert.shipping_cost,
      shipping_cost_amount: rowForUpsert.shipping_cost_amount ?? null,
      shipping_cost_currency: rowForUpsert.shipping_cost_currency ?? null,
      shipping_cost_source: rowForUpsert.shipping_cost_source ?? null,
      shipping_cost_context: rowForUpsert.shipping_cost_context ?? null,
      net_receivable: rowForUpsert.net_receivable,
      promotion_price: rowForUpsert.promotion_price,
      list_or_original_price_brl: rowForUpsert.list_or_original_price_brl,
      promotional_price_brl: rowForUpsert.promotional_price_brl,
      shipping_logistic_type: rowForUpsert.shipping_logistic_type ?? null,
      raw_payloads_keys: pay && typeof pay === "object" ? Object.keys(pay) : [],
      has_listing_prices_row: Boolean(pay && typeof pay === "object" && pay.listing_prices_row != null),
      has_orders_metrics: Boolean(pay && typeof pay === "object" && pay.orders_metrics != null),
      fee_resolution:
        rj && typeof rj === "object" && "fee_resolution" in /** @type {Record<string, unknown>} */ (rj)
          ? /** @type {Record<string, unknown>} */ (rj).fee_resolution
          : null,
    });
  }

  if (traceHealth) {
    console.info("[ML_PERSIST_HEALTH_ROW][before_upsert]", {
      external_listing_id: rowForUpsert.external_listing_id,
      item_id: itemId,
      site_id:
        itemForHealth && typeof itemForHealth === "object"
          ? /** @type {Record<string, unknown>} */ (itemForHealth).site_id ?? null
          : null,
      sale_fee_amount: rowForUpsert.sale_fee_amount,
      sale_fee_percent: rowForUpsert.sale_fee_percent,
      shipping_cost: rowForUpsert.shipping_cost,
      shipping_cost_amount: rowForUpsert.shipping_cost_amount ?? null,
      shipping_cost_context: rowForUpsert.shipping_cost_context ?? null,
      net_receivable: rowForUpsert.net_receivable,
      promotion_price: rowForUpsert.promotion_price,
    });
  }

  if (traceExisting) {
    console.info("[ML_HEALTH_SYNC_EXISTING][before_upsert]", {
      external_listing_id: rowForUpsert.external_listing_id,
      sale_fee_amount: rowForUpsert.sale_fee_amount,
      sale_fee_percent: rowForUpsert.sale_fee_percent,
      shipping_cost: rowForUpsert.shipping_cost,
      shipping_cost_amount: rowForUpsert.shipping_cost_amount ?? null,
      shipping_cost_context: rowForUpsert.shipping_cost_context ?? null,
      net_receivable: rowForUpsert.net_receivable,
      promotion_price: rowForUpsert.promotion_price,
      list_or_original_price_brl: rowForUpsert.list_or_original_price_brl,
      promotional_price_brl: rowForUpsert.promotional_price_brl,
      raw_json_has_item_excerpt:
        rowForUpsert.raw_json &&
        typeof rowForUpsert.raw_json === "object" &&
        "item_excerpt" in /** @type {Record<string, unknown>} */ (rowForUpsert.raw_json),
    });
  }

  /** @type {{ data: unknown; error: unknown } | null} */
  let upsertResult = await supabase
    .from("marketplace_listing_health")
    .upsert(rowForUpsert, { onConflict: "user_id,marketplace,external_listing_id" })
    .select("id");

  let { data, error } = upsertResult;
  while (error && isPostgrestMissingColumnError(error) && schemaTier < 3) {
    schemaTier = /** @type {0 | 1 | 2 | 3} */ (schemaTier + 1);
    rowForUpsert = mergePreserveHealthRawPayloads(
      mergePreserveMonetaryHealthColumns(cleanRow, existingRec),
      existingRec
    );
    rowForUpsert = reconcileShippingOfficialColumnsFromResolver(
      /** @type {Record<string, unknown>} */ (rowForUpsert),
      schemaTier
    );
    rowForUpsert = reconcileEstimatedSellerShippingFromBlob(
      /** @type {Record<string, unknown>} */ (rowForUpsert),
      schemaTier
    );
    rowForUpsert = stripHealthRowToSchemaTier(
      /** @type {Record<string, unknown>} */ (rowForUpsert),
      schemaTier
    );
    console.warn("[ml/health] upsert_retry_strip_columns", {
      external_listing_id: row.external_listing_id,
      schema_tier: schemaTier,
      ...formatHealthDbError(error),
    });
    upsertResult = await supabase
      .from("marketplace_listing_health")
      .upsert(rowForUpsert, { onConflict: "user_id,marketplace,external_listing_id" })
      .select("id");
    ({ data, error } = upsertResult);
  }

  if (error) {
    syncMetrics.upsertFailed += 1;
    const formatted = formatPostgrestError(error);
    log("health_upsert_failed", { external_listing_id: row.external_listing_id, ...formatted });
    console.error("[ml/health] upsert_error", {
      external_listing_id: row.external_listing_id,
      schema_tier_final: schemaTier,
      ...formatted,
      payload_summary: healthPayloadSummaryForLog(/** @type {Record<string, unknown>} */ (rowForUpsert)),
      hint:
        isPostgrestMissingColumnError(error)
          ? "Possível schema desatualizado: aplique migrations SQL de marketplace_listing_health (shipping v2, payout/subsídio)."
          : undefined,
    });
    pushSampleError({ stage: "upsert", external_listing_id: row.external_listing_id, ...formatted });
    if (mlFeeValidateLogsEnabled()) {
      console.info("[ML_FEE_VALIDATE][health_upsert_result]", {
        external_listing_id: String(rowForUpsert.external_listing_id ?? itemId),
        ok: false,
        ...formatted,
      });
    }
    if (traceExisting) {
      console.info("[ML_HEALTH_SYNC_EXISTING][after_upsert]", {
        external_listing_id: itemId,
        ok: false,
        ...formatted,
      });
    }
    await logMlFeeDebugAfterUpsert(
      supabase,
      userId,
      marketplace,
      itemId,
      itemForHealth,
      /** @type {Record<string, unknown>} */ (row),
      /** @type {Record<string, unknown>} */ (rowForUpsert),
      false,
      accessToken
    );
    emitMlFeeSyncLineLog(itemId, itemForHealth, rowForUpsert, false);
    return false;
  }

  syncMetrics.upsertOk += 1;
  const rowId = Array.isArray(data) && data[0]?.id != null ? data[0].id : null;

  const snapshotReason = opts.financialSnapshot?.reason ?? SNAPSHOT_REASON.HEALTH_SYNC;
  const snapshotSource = opts.financialSnapshot?.source ?? SNAPSHOT_SOURCE.ML_HEALTH_SYNC;
  scheduleListingHealthFinancialSnapshot(
    supabase,
    {
      existingHealthRow: existingRec,
      mergedRowForUpsert: /** @type {Record<string, unknown>} */ (rowForUpsert),
      marketplaceListingHealthId: rowId != null ? String(rowId) : null,
      userId,
      marketplace,
      externalListingId: String(cleanRow.external_listing_id),
      snapshotReason,
      snapshotSource,
    },
    { external_listing_id: itemId }
  );
  if (item && typeof item === "object") {
    const listingDbId = /** @type {Record<string, unknown>} */ (item)._suse7_listing_uuid;
    if (listingDbId != null && String(listingDbId).trim() !== "") {
      void createListingSnapshot(supabase, {
        userId,
        listingId: String(listingDbId),
        marketplace,
        capturedAt: nowIso,
      });
    }
  }

  if (verbose) {
    console.log("[ml/health] upsert_ok", {
      external_listing_id: itemId,
      row_id: rowId,
    });
  }
  if (mlFeeValidateLogsEnabled()) {
    console.info("[ML_FEE_VALIDATE][health_upsert_result]", {
      external_listing_id: itemId,
      ok: true,
      row_id: rowId,
    });
  }

  if (traceExisting) {
    console.info("[ML_HEALTH_SYNC_EXISTING][after_upsert]", {
      external_listing_id: itemId,
      ok: true,
      row_id: rowId,
    });
  }

  if (traceHealth) {
    const verifySel = `external_listing_id, ${buildHealthExistingSelectString(schemaTier)}`;
    const { data: verifyRow, error: verifyErr } = await supabase
      .from("marketplace_listing_health")
      .select(verifySel)
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("external_listing_id", String(rowForUpsert.external_listing_id))
      .maybeSingle();
    console.info("[ML_PERSIST_HEALTH_ROW][after_upsert_verify]", {
      external_listing_id: String(cleanRow.external_listing_id),
      upsert_row_id: rowId,
      read_ok: !verifyErr,
      read_error: verifyErr?.message != null ? String(verifyErr.message) : null,
      db_row: verifyRow ?? null,
    });
  }

  await logMlFeeDebugAfterUpsert(
    supabase,
    userId,
    marketplace,
    itemId,
    itemForHealth,
    /** @type {Record<string, unknown>} */ (row),
    /** @type {Record<string, unknown>} */ (rowForUpsert),
    true,
    accessToken
  );
  emitMlFeeSyncLineLog(itemId, itemForHealth, rowForUpsert, true);
  return true;
}
