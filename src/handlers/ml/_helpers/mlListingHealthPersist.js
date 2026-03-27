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

import { fetchItemListingPerformance, fetchItemVisitsTotal } from "./mercadoLibreItemsApi.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

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
function toFiniteNumber(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} v */
function toInt(v) {
  const n = toFiniteNumber(v);
  if (n == null) return null;
  return Math.trunc(n);
}

function extractSaleFee(item) {
  const d = item?.sale_fee_details;
  if (!d || typeof d !== "object") return { percent: null, amount: null };
  const percent = toFiniteNumber(d.percentage_fee ?? d.meli_percentage_fee);
  const amount = toFiniteNumber(d.gross_amount ?? d.fixed_fee);
  return { percent, amount };
}

function extractShippingCost(item) {
  const sh = item?.shipping;
  if (!sh || typeof sh !== "object") return null;
  const c = toFiniteNumber(sh.cost ?? sh.list_cost ?? sh.default_cost);
  if (c != null) return c;
  const fm = sh.free_methods;
  if (Array.isArray(fm) && fm[0] && typeof fm[0] === "object") {
    return toFiniteNumber(fm[0].cost ?? fm[0].rule?.default_cost);
  }
  return null;
}

function extractPromotionPrice(item) {
  const orig = toFiniteNumber(item?.original_price);
  const price = toFiniteNumber(item?.price);
  if (orig != null && price != null && orig > price) return price;
  return null;
}

function extractNetReceivableExplicit(item) {
  const d = item?.sale_fee_details;
  if (d && typeof d === "object") {
    const n = toFiniteNumber(d.net_amount ?? d.seller_net_amount ?? d.net_sale_amount);
    if (n != null) return n;
  }
  return toFiniteNumber(item?.seller_net_amount ?? item?.net_sale_amount);
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
    currency_id: item.currency_id,
    sale_fee_details: item.sale_fee_details ?? null,
    shipping:
      sh && typeof sh === "object"
        ? {
            mode: sh.mode,
            logistic_type: sh.logistic_type,
            cost: sh.cost ?? sh.list_cost,
            free_shipping: sh.free_shipping,
          }
        : null,
  };
}

/**
 * Monta linha a partir do item ML + respostas auxiliares (visits / performance).
 */
export function mapMlToListingHealthRow(userId, item, marketplace, nowIso, aux = {}) {
  const extId = item?.id != null ? String(item.id) : null;
  if (!extId) throw new Error("Item sem id para health");

  const fee = extractSaleFee(item);
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

  const sh = item?.shipping;
  const shipMode = sh?.mode != null ? String(sh.mode) : null;
  const shipLog = sh?.logistic_type != null ? String(sh.logistic_type) : null;

  const raw = {
    item_excerpt: itemExcerptForRaw(item),
    visits_api: aux.visitsRaw ?? null,
    performance_api: perf,
    sale_fee_details: item?.sale_fee_details ?? null,
    shipping_snapshot: sh && typeof sh === "object" ? { mode: sh.mode, logistic_type: sh.logistic_type } : null,
  };

  return {
    user_id: userId,
    marketplace,
    external_listing_id: extId,
    visits,
    orders_count: null,
    conversion_rate: null,
    sale_fee_percent: fee.percent,
    sale_fee_amount: fee.amount,
    shipping_cost: extractShippingCost(item),
    net_receivable: extractNetReceivableExplicit(item),
    promotion_price: extractPromotionPrice(item),
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
 * Upsert health; não lança — incrementa métricas e loga.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function upsertMarketplaceListingHealthFromMlItem(supabase, userId, item, opts = {}) {
  const log = opts.log || (() => {});
  const accessToken = opts.accessToken;
  const nowIso = opts.nowIso || new Date().toISOString();
  const marketplace = opts.marketplace || ML_MARKETPLACE_SLUG;

  const skipVisits = process.env.ML_SYNC_SKIP_VISITS === "1";
  const skipPerf = process.env.ML_SYNC_SKIP_PERFORMANCE === "1";
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
    return;
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
    row = mapMlToListingHealthRow(userId, item, marketplace, nowIso, {
      visitsTotal,
      visitsRaw,
      performance,
    });
  } catch (e) {
    syncMetrics.mapFailed += 1;
    const msg = e?.message || String(e);
    log("health_map_failed", { itemId, message: msg });
    console.error("[ml/health] map_failed", { external_listing_id: itemId, message: msg });
    pushSampleError({ stage: "map", external_listing_id: itemId, ...formatPostgrestError(e) });
    return;
  }

  const cleanRow = prepareRowForUpsert(row);

  const { data, error } = await supabase
    .from("marketplace_listing_health")
    .upsert(cleanRow, { onConflict: "user_id,marketplace,external_listing_id" })
    .select("id");

  if (error) {
    syncMetrics.upsertFailed += 1;
    const formatted = formatPostgrestError(error);
    log("health_upsert_failed", { external_listing_id: row.external_listing_id, ...formatted });
    console.error("[ml/health] upsert_error", {
      external_listing_id: row.external_listing_id,
      ...formatted,
    });
    pushSampleError({ stage: "upsert", external_listing_id: row.external_listing_id, ...formatted });
    return;
  }

  syncMetrics.upsertOk += 1;
  const rowId = Array.isArray(data) && data[0]?.id != null ? data[0].id : null;
  if (verbose) {
    console.log("[ml/health] upsert_ok", {
      external_listing_id: itemId,
      row_id: rowId,
    });
  }
}
