// ======================================================
// Chamadas HTTP à API pública do Mercado Livre (itens / descrição)
// Sem lógica de persistência — apenas fetch + parse JSON.
//
// Diagnóstico taxa listing_prices (logs JSON): ML_LISTING_FEE_DEBUG=1 ou
// ML_LISTING_FEE_DEBUG_EXT_ID (default: id contendo 4473596489).
// JSON bruto completo: ML_LISTING_PRICES_RAW_LOG=1 ou ML_LISTING_PRICES_RAW_LOG_EXT_ID (substring do MLB…).
// Preço bruto do item: ML_ITEM_DEBUG=1 ou ML_ITEM_DEBUG_EXT_ID (substring, ex. 4402165843).
// Auto-sync usa GET /items/:id por padrão; multiget leve: ML_AUTO_SYNC_USE_MULTIGET=1.
// ======================================================

import {
  coalesceListingPricesPersistedFeeAmount,
  extractOfficialMercadoLibreListingPricesFee,
  extractPromotionPrice,
  extractSaleFee,
  extractShippingCost,
  toFiniteFeeScalar,
  toFiniteNumber,
} from "./mlItemMoneyExtract.js";
import { resolveMercadoLivreSalePriceOfficial } from "../../../domain/pricing/mercadoLivreSalePriceOfficial.js";
import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "../../../domain/pricing/pricingInconsistencyLog.js";
import { extractMlPictureHttpFromObject } from "./mercadoLibreListingCoverImage.js";

const ML_API = "https://api.mercadolibre.com";

/**
 * Logs de taxa/listing_prices no terminal (ML_LISTING_FEE_DEBUG=1 ou id contendo ML_LISTING_FEE_DEBUG_EXT_ID).
 * @param {Record<string, unknown> | null | undefined} item
 */
export function mlListingFeeDebugEnabled(item) {
  if (process.env.ML_LISTING_FEE_DEBUG === "1") return true;
  const id = item?.id != null ? String(item.id) : "";
  const needle = String(process.env.ML_LISTING_FEE_DEBUG_EXT_ID ?? "4473596489").trim();
  return needle !== "" && id.includes(needle);
}

/**
 * Log pontual de preços no fetch (ML_ITEM_DEBUG=1 ou id contém ML_ITEM_DEBUG_EXT_ID).
 * @param {unknown} itemId
 */
export function mlItemDebugEnabledForId(itemId) {
  if (process.env.ML_ITEM_DEBUG === "1") return true;
  const needle = String(process.env.ML_ITEM_DEBUG_EXT_ID ?? "").trim();
  if (!needle || itemId == null) return false;
  return String(itemId).includes(needle);
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {string} source — ex. "GET /items/:id" | "GET /items?ids= (multiget)"
 */
export function logMlItemDebug(item, source) {
  if (!item || typeof item !== "object") return;
  const id = item.id != null ? String(item.id) : "";
  if (!mlItemDebugEnabledForId(id)) return;
  console.log("[ML_ITEM_DEBUG]", {
    source,
    id: item.id ?? null,
    price: item.price ?? null,
    original_price: item.original_price ?? null,
    base_price: item.base_price ?? null,
  });
}

/** IDs fixos para auditoria de frete + listing_prices (request/response no raw_json). */
const LISTING_PRICES_SHIPPING_AUDIT_EXT_IDS = /** @type {const} */ ([
  "MLB6087353806",
  "MLB4473797855",
]);

/**
 * Log/persistência estendida de GET /sites/…/listing_prices para diagnóstico de frete oficial.
 * `ML_LISTING_PRICES_SHIPPING_AUDIT=1` ou `ML_LISTING_PRICES_SHIPPING_AUDIT_EXT_ID=substring` ou IDs fixos acima.
 * @param {unknown} item
 */
export function mlListingPricesShippingAuditLogEnabled(item) {
  if (process.env.ML_LISTING_PRICES_SHIPPING_AUDIT === "1") return true;
  const needle = String(process.env.ML_LISTING_PRICES_SHIPPING_AUDIT_EXT_ID ?? "").trim();
  const id = item?.id != null ? String(item.id) : "";
  const norm = id.replace(/\s/g, "").toUpperCase();
  if (needle !== "" && norm.includes(needle.toUpperCase())) return true;
  for (const x of LISTING_PRICES_SHIPPING_AUDIT_EXT_IDS) {
    if (norm === x.toUpperCase() || id.includes(x)) return true;
  }
  return false;
}

/** Logs pontuais do fluxo taxa → listing_prices → health (desligar em produção: não definir env). */
export function mlFeeFlowValidateEnabled() {
  return process.env.ML_FEE_FLOW_VALIDATE === "1";
}

/** Logs dos 4 pontos do fluxo financeiro (ML_FEE_VALIDATE=1 ou legado ML_FEE_FLOW_VALIDATE=1). */
export function mlFeeValidateLogsEnabled() {
  return process.env.ML_FEE_VALIDATE === "1" || mlFeeFlowValidateEnabled();
}

/** Logs de validação preço list/promo (ML_PRICE_VALIDATE=1 ou mesmo critério do fluxo de taxa). */
export function mlPriceValidateLogsEnabled() {
  return process.env.ML_PRICE_VALIDATE === "1" || mlFeeValidateLogsEnabled();
}

/**
 * Dump completo do JSON de GET /sites/…/listing_prices no terminal (temporário / diagnóstico).
 * `ML_LISTING_PRICES_RAW_LOG=1` ou `ML_LISTING_PRICES_RAW_LOG_EXT_ID=6046839404` (substring do id).
 * @param {Record<string, unknown> | null | undefined} item
 */
export function mlListingPricesRawFullLogEnabled(item) {
  if (process.env.ML_LISTING_PRICES_RAW_LOG === "1") return true;
  const id = item?.id != null ? String(item.id) : "";
  const needle = String(process.env.ML_LISTING_PRICES_RAW_LOG_EXT_ID ?? "").trim();
  return needle !== "" && id.includes(needle);
}

/** Log estruturado [ML_FEE_DEBUG] no persist (ML_FEE_DEBUG=1). */
export function mlFeeDebugEnabled() {
  return process.env.ML_FEE_DEBUG === "1";
}

/**
 * Recorte seguro para persistir em marketplace_listing_health.raw_json.raw_payloads (sem PII).
 * @param {Record<string, unknown> | null} row
 */
export function listingPricesRowExcerptForPersist(row) {
  if (!row || typeof row !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  return {
    listing_type_id: r.listing_type_id ?? r.mapping ?? null,
    sale_fee_amount_hint: coalescePositiveFeeAmount(r.sale_fee_amount, r.selling_fee, r.sale_fee),
    has_sale_fee_details: Boolean(r.sale_fee_details),
  };
}

/**
 * Linha escolhida de listing_prices para gravar em `marketplace_listing_health.raw_json.raw_payloads`.
 * Persiste o objeto completo retornado pelo ML (clone JSON-safe) para auditoria e extração de tarifa bruta/efetiva.
 * @param {Record<string, unknown> | null} row
 */
export function listingPricesRowForHealthPersist(row) {
  if (!row || typeof row !== "object") return null;
  try {
    return JSON.parse(
      JSON.stringify(row, (_k, val) => {
        if (val === undefined) return null;
        if (typeof val === "bigint") return val.toString();
        return val;
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Snapshot persistível do endpoint oficial de frete do seller.
 * @param {Record<string, unknown> | null} payload
 */
export function shippingOptionsFreeForHealthPersist(payload) {
  if (!payload || typeof payload !== "object") return null;
  const p = /** @type {Record<string, unknown>} */ (payload);
  const cov =
    p.coverage && typeof p.coverage === "object"
      ? /** @type {Record<string, unknown>} */ (p.coverage)
      : null;
  const ac =
    cov?.all_country && typeof cov.all_country === "object"
      ? /** @type {Record<string, unknown>} */ (cov.all_country)
      : null;
  const discount =
    ac?.discount && typeof ac.discount === "object"
      ? /** @type {Record<string, unknown>} */ (ac.discount)
      : null;
  const listCost = toFiniteNumber(ac?.list_cost);
  const promoted = toFiniteNumber(discount?.promoted_amount);
  const payable =
    listCost != null && promoted != null && promoted > 0 && promoted < listCost
      ? Math.round((listCost - promoted) * 100) / 100
      : listCost;
  return {
    list_cost: listCost,
    promoted_amount: promoted,
    payable_cost: payable,
    currency_id: ac?.currency_id ?? p.currency_id ?? null,
    source_endpoint: "users/:id/shipping_options/free",
    discount: discount ?? null,
  };
}

/**
 * Endpoint oficial de custo de envio do seller (base do "A pagar R$ xx,xx" do painel ML).
 * @param {string} accessToken
 * @param {Record<string, unknown>} item
 * @returns {Promise<{ payload: Record<string, unknown> | null; amount: number | null; source_field: string | null }>}
 */
export async function fetchSellerShippingOptionsFree(accessToken, item) {
  const listingId = item?.id != null ? String(item.id) : null;
  const sellerId =
    item?.seller_id != null && String(item.seller_id).trim() !== ""
      ? String(item.seller_id).trim()
      : null;
  const itemPrice = toFiniteNumber(item?.price);
  const listingTypeId =
    item?.listing_type_id != null && String(item.listing_type_id).trim() !== ""
      ? String(item.listing_type_id).trim()
      : null;
  const sh = item?.shipping && typeof item.shipping === "object" ? item.shipping : null;
  const logisticType =
    sh?.logistic_type != null && String(sh.logistic_type).trim() !== ""
      ? String(sh.logistic_type).trim()
      : null;
  const mode =
    sh?.mode != null && String(sh.mode).trim() !== "" ? String(sh.mode).trim() : null;
  const freeShipping = sh?.free_shipping === true ? "true" : "false";
  const condition =
    item?.condition != null && String(item.condition).trim() !== ""
      ? String(item.condition).trim()
      : "new";

  if (!sellerId || itemPrice == null || itemPrice <= 0) {
    return { payload: null, amount: null, source_field: null };
  }

  const params = new URLSearchParams();
  if (listingId != null) params.set("item_id", listingId);
  params.set("item_price", String(itemPrice));
  if (listingTypeId != null) params.set("listing_type_id", listingTypeId);
  if (mode != null) params.set("mode", mode);
  if (logisticType != null) params.set("logistic_type", logisticType);
  params.set("condition", condition);
  params.set("free_shipping", freeShipping);
  params.set("verbose", "true");

  const url = `${ML_API}/users/${encodeURIComponent(sellerId)}/shipping_options/free?${params.toString()}`;
  logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_OPTIONS_FREE_FETCH_STARTED, {
    marketplace: "mercado_livre",
    listing_id: listingId,
    external_listing_id: listingId,
    source_endpoint: "/users/{id}/shipping_options/free",
    item_price: itemPrice,
    listing_type_id: listingTypeId,
    logistic_type: logisticType,
    free_shipping: sh?.free_shipping ?? null,
    source: "ml_shipping_options_free",
  });

  let json = null;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    json = await res.json().catch(() => null);
    if (!res.ok || !json || typeof json !== "object" || Array.isArray(json)) {
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_OPTIONS_FREE_FETCH_FAILED, {
        marketplace: "mercado_livre",
        listing_id: listingId,
        external_listing_id: listingId,
        source_endpoint: "/users/{id}/shipping_options/free",
        status: res.status,
        item_price: itemPrice,
        listing_type_id: listingTypeId,
        logistic_type: logisticType,
        free_shipping: sh?.free_shipping ?? null,
        source: "ml_shipping_options_free",
      });
      return { payload: null, amount: null, source_field: null };
    }
  } catch (e) {
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_OPTIONS_FREE_FETCH_FAILED, {
      marketplace: "mercado_livre",
      listing_id: listingId,
      external_listing_id: listingId,
      source_endpoint: "/users/{id}/shipping_options/free",
      item_price: itemPrice,
      listing_type_id: listingTypeId,
      logistic_type: logisticType,
      free_shipping: sh?.free_shipping ?? null,
      source: "ml_shipping_options_free",
      error: e instanceof Error ? e.message : String(e),
    });
    return { payload: null, amount: null, source_field: null };
  }

  const persisted = shippingOptionsFreeForHealthPersist(/** @type {Record<string, unknown>} */ (json));
  const selected = toFiniteNumber(persisted?.payable_cost);
  logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_OPTIONS_FREE_FETCH_SUCCESS, {
    marketplace: "mercado_livre",
    listing_id: listingId,
    external_listing_id: listingId,
    source_endpoint: "/users/{id}/shipping_options/free",
    item_price: itemPrice,
    listing_type_id: listingTypeId,
    logistic_type: logisticType,
    free_shipping: sh?.free_shipping ?? null,
    selected_value: selected,
    source: "ml_shipping_options_free",
  });
  if (selected != null && selected > 0) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_OPTIONS_FREE_VALUE_SELECTED, {
      marketplace: "mercado_livre",
      listing_id: listingId,
      external_listing_id: listingId,
      source_endpoint: "/users/{id}/shipping_options/free",
      candidate_field: "coverage.all_country.list_cost - discount.promoted_amount",
      selected_value: selected,
      source: "ml_shipping_options_free",
    });
    return {
      payload: persisted,
      amount: selected,
      source_field: "coverage.all_country.list_cost/discount.promoted_amount",
    };
  }
  logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_OPTIONS_FREE_VALUE_MISSING, {
    marketplace: "mercado_livre",
    listing_id: listingId,
    external_listing_id: listingId,
    source_endpoint: "/users/{id}/shipping_options/free",
    candidate_field: "coverage.all_country.list_cost",
    selected_value: null,
    source: "ml_shipping_options_free",
  });
  return { payload: persisted, amount: null, source_field: "coverage.all_country.list_cost" };
}

/**
 * ML às vezes devolve a linha de taxa no root (sem `rows` / `results`):
 * `{ sale_fee_amount, sale_fee_details: { percentage_fee, ... } }`.
 */
function isDirectListingPricesRowObject(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const r = /** @type {Record<string, unknown>} */ (o);
  const hasDetails = r.sale_fee_details != null;
  const amt = coalescePositiveFeeAmount(r.sale_fee_amount, r.selling_fee, r.sale_fee);
  if (hasDetails || amt != null) return true;
  return false;
}

/** @param {unknown} json */
function listingPricesArrayFromResponseJson(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = /** @type {Record<string, unknown>} */ (json);
    for (const k of ["listing_prices", "results", "rows", "data", "content", "items", "values", "fees"]) {
      const c = o[k];
      if (Array.isArray(c)) return c;
    }
    if (isDirectListingPricesRowObject(o)) {
      return [o];
    }
  }
  return [];
}

/** @param {unknown[]} vals */
function coalescePositiveFeeAmount(...vals) {
  for (const v of vals) {
    const n = toFiniteFeeScalar(v);
    if (n != null && n > 0) return n;
  }
  return null;
}

/**
 * Para escolher linha de listing_prices: mesma regra do health — tarifa **efetiva**
 * (selling_fee / breakdown com subsídio), não `sale_fee_amount` bruto primeiro.
 * @param {Record<string, unknown>} pr
 */
function listingPricesRowSynthForExtract(item, pr) {
  const eff =
    coalesceListingPricesPersistedFeeAmount(pr) ??
    coalescePositiveFeeAmount(pr.sale_fee_amount, pr.selling_fee, pr.sale_fee);
  return {
    ...item,
    sale_fee_amount: eff,
    sale_fee_details: pr.sale_fee_details,
  };
}

/**
 * Escolhe a linha de listing_prices com taxa parseável; evita ficar preso em arr[0] sem fee.
 * Com `listing_type_id` conhecido, prefere a menor tarifa **efetiva** entre linhas do tipo
 * (evita escolher variante “bruta” 4,52 quando existe efetiva 3,52 com subsídio ML).
 * @param {Record<string, unknown>} item
 * @param {unknown[]} arr
 */
function pickBestListingPricesRow(item, arr) {
  const wantLt = item.listing_type_id != null ? String(item.listing_type_id).trim() : "";
  /** @param {Record<string, unknown>} pr */
  const rowMatchesLt = (pr) => {
    if (!wantLt) return true;
    return (
      String(pr.listing_type_id ?? "") === wantLt || String(pr.mapping ?? "") === wantLt
    );
  };
  /** Não retornar a primeira linha do tipo: pode ser só o bruto; o loop escolhe a menor tarifa efetiva. */
  const distinctListingTypes = new Set(
    arr
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const o = /** @type {Record<string, unknown>} */ (x);
        const lt = o.listing_type_id ?? o.mapping ?? o.listing_type;
        return lt != null && String(lt).trim() !== "" ? String(lt).trim() : "";
      })
      .filter((s) => s !== ""),
  );
  /** Sem `listing_type_id` no item e vários tipos na resposta → não minimizar entre todos (evita classic vs premium). */
  const minAcrossEligible =
    String(wantLt).trim() !== "" || distinctListingTypes.size <= 1;

  /** @type {Record<string, unknown> | null} */
  let best = null;
  let bestKeyMin = Number.POSITIVE_INFINITY;
  let bestKeyMax = -1;
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const pr = /** @type {Record<string, unknown>} */ (r);
    if (!rowMatchesLt(pr)) continue;
    const ex = extractSaleFee(listingPricesRowSynthForExtract(item, pr), {
      deriveFromPercent: true,
      listing: /** @type {Record<string, unknown>} */ (item),
      skipDeepExtract: true,
    });
    const eff = coalesceListingPricesPersistedFeeAmount(pr);
    const a = ex.amount ?? 0;
    const candidate = eff != null && eff > 0 ? eff : a;
    if (candidate <= 0) continue;
    if (minAcrossEligible) {
      if (candidate < bestKeyMin - 0.0001) {
        bestKeyMin = candidate;
        best = pr;
      }
    } else if (candidate > bestKeyMax) {
      bestKeyMax = candidate;
      best = pr;
    }
  }
  if (best != null) {
    if (minAcrossEligible && bestKeyMin !== Number.POSITIVE_INFINITY && bestKeyMin > 0) return best;
    if (!minAcrossEligible && bestKeyMax > 0) return best;
  }
  const withDetails = arr.find(
    (r) =>
      r &&
      typeof r === "object" &&
      /** @type {Record<string, unknown>} */ (r).sale_fee_details &&
      (/** @type {Record<string, unknown>} */ (r).sale_fee_amount != null ||
        /** @type {Record<string, unknown>} */ (r).sale_fee_details)
  );
  if (withDetails && typeof withDetails === "object") return /** @type {Record<string, unknown>} */ (withDetails);
  const first = arr[0];
  return first && typeof first === "object" ? /** @type {Record<string, unknown>} */ (first) : null;
}

/** @param {unknown} v @param {number} [max] */
function jsonSnippet(v, max = 3500) {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

/**
 * @param {string} accessToken
 * @param {string} sellerId - ml_user_id do vendedor
 * @param {number} offset
 * @param {number} limit - máx. típico 100
 */
export async function fetchUserItemIdsPage(accessToken, sellerId, offset, limit) {
  const url = `${ML_API}/users/${encodeURIComponent(sellerId)}/items/search?limit=${limit}&offset=${offset}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML search HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return {
    results: Array.isArray(json.results) ? json.results : [],
    paging: json.paging || { total: 0, offset: 0, limit },
  };
}

/**
 * Detalhe completo do anúncio (inclui atributos, fotos, variações, shipping).
 */
export async function fetchItem(accessToken, itemId) {
  const url = `${ML_API}/items/${encodeURIComponent(itemId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML item HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  logMlItemDebug(/** @type {Record<string, unknown>} */ (json), "GET /items/:id");
  return json;
}

/** Máx. de IDs por requisição no multiget público do ML (documentação ~20). */
const ITEMS_MULTIGET_CHUNK = 20;

/**
 * Detalhe de vários anúncios em uma chamada: GET /items?ids=ID1,ID2,...
 * @param {string} accessToken
 * @param {string[]} itemIds
 * @returns {Promise<Map<string, Record<string, unknown>>>} id → corpo do item (só code 200)
 */
export async function fetchItemsByIds(accessToken, itemIds) {
  const unique = [...new Set(itemIds.map((id) => String(id).trim()).filter(Boolean))];
  /** @type {Map<string, Record<string, unknown>>} */
  const out = new Map();

  for (let i = 0; i < unique.length; i += ITEMS_MULTIGET_CHUNK) {
    const chunk = unique.slice(i, i + ITEMS_MULTIGET_CHUNK);
    const q = chunk.map((id) => encodeURIComponent(id)).join(",");
    const url = `${ML_API}/items?ids=${q}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(
        (json && json.message) || (json && json.error) || `ML items multiget HTTP ${res.status}`
      );
      err.status = res.status;
      err.body = json;
      throw err;
    }

    const arr = Array.isArray(json) ? json : [];
    for (const entry of arr) {
      if (entry && typeof entry === "object" && entry.code === 200 && entry.body && entry.body.id) {
        logMlItemDebug(
          /** @type {Record<string, unknown>} */ (entry.body),
          "GET /items?ids= (multiget)"
        );
        out.set(String(entry.body.id), entry.body);
      }
    }
  }

  return out;
}

/**
 * Um GET /items/:id por ID — fonte mais atual que o multiget `GET /items?ids=` (preço/taxas às vezes defasados).
 * @param {string} accessToken
 * @param {string[]} itemIds
 * @param {number} [concurrency=6]
 * @returns {Promise<Map<string, Record<string, unknown>>>}
 */
export async function fetchItemsDetailByIds(accessToken, itemIds, concurrency = 6) {
  const unique = [...new Set(itemIds.map((id) => String(id).trim()).filter(Boolean))];
  const conc = Math.max(1, Math.min(12, Number(concurrency) || 6));
  /** @type {Map<string, Record<string, unknown>>} */
  const out = new Map();

  for (let i = 0; i < unique.length; i += conc) {
    const chunk = unique.slice(i, i + conc);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const item = await fetchItem(accessToken, id);
          if (item && typeof item === "object" && item.id != null) {
            out.set(String(item.id), /** @type {Record<string, unknown>} */ (item));
          }
        } catch (e) {
          console.warn("[ML_ITEMS_DETAIL_FETCH] item_skip", {
            id,
            message: e?.message ? String(e.message) : String(e),
          });
        }
      })
    );
  }

  return out;
}

/**
 * Descrição (texto). Alguns itens retornam 403/404 — tratar no caller.
 */
export async function fetchItemDescription(accessToken, itemId) {
  const url = `${ML_API}/items/${encodeURIComponent(itemId)}/description`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `ML description HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Interpreta respostas de visitas (formatos variam entre /visits/items e /items/visits).
 * @param {unknown} json
 * @param {string} itemId
 * @returns {number | null}
 */
function parseVisitsPayload(json, itemId) {
  if (json == null) return null;
  if (typeof json === "object" && !Array.isArray(json)) {
    if (typeof json.total_visits === "number" && Number.isFinite(json.total_visits)) {
      return Math.trunc(json.total_visits);
    }
    const v = json[itemId];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (v && typeof v === "object") {
      if (typeof v.total === "number" && Number.isFinite(v.total)) return Math.trunc(v.total);
      if (typeof v.total_visits === "number" && Number.isFinite(v.total_visits)) {
        return Math.trunc(v.total_visits);
      }
    }
  }
  if (Array.isArray(json)) {
    for (const row of json) {
      if (!row || typeof row !== "object") continue;
      const rid = row.item_id != null ? String(row.item_id) : null;
      if (rid && rid !== itemId) continue;
      const t = row.total_visits ?? row.visits ?? row.total;
      if (typeof t === "number" && Number.isFinite(t)) return Math.trunc(t);
    }
    const first = json[0];
    if (first && typeof first === "object") {
      const t = first.total_visits ?? first.visits ?? first.total;
      if (typeof t === "number" && Number.isFinite(t)) return Math.trunc(t);
    }
  }
  return null;
}

/**
 * Total de visitas do anúncio (Bearer obrigatório). Tenta rotas em uso pelo ML.
 * @param {string} accessToken
 * @param {string} itemId
 * @returns {Promise<{ total: number | null; raw: unknown }>}
 */
export async function fetchItemVisitsTotal(accessToken, itemId) {
  const id = encodeURIComponent(itemId);
  const urls = [`${ML_API}/visits/items?ids=${id}`, `${ML_API}/items/visits?ids=${id}`];
  let lastRaw = null;
  for (const url of urls) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = await res.json().catch(() => ({}));
    lastRaw = json;
    if (!res.ok) continue;
    const total = parseVisitsPayload(json, itemId);
    if (total != null) return { total, raw: json };
  }
  return { total: null, raw: lastRaw };
}

/**
 * Qualidade / experiência: /performance (preferencial) e fallback /health.
 * @param {string} accessToken
 * @param {string} itemId
 */
export async function fetchItemListingPerformance(accessToken, itemId) {
  const id = encodeURIComponent(itemId);
  const paths = [`/items/${id}/performance`, `/item/${id}/performance`, `/items/${id}/health`];
  for (const p of paths) {
    const url = `${ML_API}${p}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json && typeof json === "object" && !Array.isArray(json)) {
      return json;
    }
  }
  return null;
}

/**
 * Taxas de venda por tipo de anúncio — GET /sites/:site_id/listing_prices (corpo bruto + linha escolhida).
 * @param {string} accessToken
 * @param {Record<string, unknown>} item — site_id, price, listing_type_id, category_id, currency_id, shipping
 * @param {{ omitShippingParams?: boolean }} [opts]
 * @returns {Promise<{
 *   row: Record<string, unknown> | null;
 *   rawJson: unknown;
 *   requestUrl: string | null;
 *   httpStatus: number | null;
 *   httpOk: boolean;
 *   skipReason: string | null;
 * }>}
 */
export async function fetchListingPricesForItemDetailed(accessToken, item, opts = {}) {
  const omitShippingParams = opts.omitShippingParams === true;
  let siteId = item?.site_id != null ? String(item.site_id).trim() : "";
  if (!siteId && item?.id != null) {
    const idStr = String(item.id);
    const m = idStr.match(/^([A-Z]{3})\d/i);
    if (m) siteId = m[1].toUpperCase();
  }
  const price = item?.price != null ? Number(item.price) : NaN;
  const debug = mlListingFeeDebugEnabled(item);
  const feeDbg = mlFeeDebugEnabled();
  if (!siteId || !Number.isFinite(price) || price <= 0) {
    /** @type {string} */
    let skipReason = "missing_or_invalid_price";
    if (!siteId) skipReason = "missing_site_id";
    else if (!Number.isFinite(price) || price <= 0) skipReason = "missing_or_invalid_price";
    if (feeDbg) {
      console.info(
        "[ML_FEE_DEBUG]",
        JSON.stringify({
          phase: "listing_prices_skip",
          listing_id: item?.id ?? null,
          skip_reason: skipReason,
          has_listing_prices: false,
          listing_prices_row: null,
          sale_fee_amount_calculated: null,
          sale_fee_percent_calculated: null,
          persisted_sale_fee_amount: null,
          persisted_sale_fee_percent: null,
          site_id_resolved: siteId || null,
          price_param: item?.price ?? null,
          price_parsed: Number.isFinite(price) ? price : null,
        })
      );
    }
    if (debug) {
      console.info("[ML_LISTING_PRICES_HTTP][skip_bad_params]", {
        item_id: item?.id ?? null,
        skip_reason: skipReason,
        site_id: siteId || null,
        price_param: item?.price ?? null,
        price_parsed: Number.isFinite(price) ? price : null,
      });
    }
    return {
      row: null,
      rawJson: null,
      requestUrl: null,
      httpStatus: null,
      httpOk: false,
      skipReason,
    };
  }

  const params = new URLSearchParams();
  params.set("price", String(price));
  if (item.currency_id != null && String(item.currency_id).trim() !== "") {
    params.set("currency_id", String(item.currency_id).trim());
  }
  if (item.category_id != null && String(item.category_id).trim() !== "") {
    params.set("category_id", String(item.category_id).trim());
  }
  if (item.listing_type_id != null && String(item.listing_type_id).trim() !== "") {
    params.set("listing_type_id", String(item.listing_type_id).trim());
  }
  const sh = item?.shipping && typeof item.shipping === "object" ? item.shipping : null;
  if (!omitShippingParams) {
    if (sh?.logistic_type != null && String(sh.logistic_type).trim() !== "") {
      params.set("logistic_type", String(sh.logistic_type).trim());
    }
    if (sh?.mode != null && String(sh.mode).trim() !== "") {
      params.set("shipping_mode", String(sh.mode).trim());
    }
  }

  const url = `${ML_API}/sites/${encodeURIComponent(siteId)}/listing_prices?${params.toString()}`;

  const currencyId =
    item?.currency_id != null && String(item.currency_id).trim() !== ""
      ? String(item.currency_id).trim()
      : null;
  const listingTypeId =
    item?.listing_type_id != null && String(item.listing_type_id).trim() !== ""
      ? String(item.listing_type_id).trim()
      : null;
  const categoryId =
    item?.category_id != null && String(item.category_id).trim() !== ""
      ? String(item.category_id).trim()
      : null;

  if (feeDbg || debug || mlFeeValidateLogsEnabled()) {
    console.info("[ML_LISTING_PRICES][before_http]", {
      listing_id: item?.id ?? null,
      price,
      site_id: siteId,
      currency_id: currencyId,
      listing_type_id: listingTypeId,
      category_id: categoryId,
      request_url: url,
      omit_shipping_params: omitShippingParams,
    });
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = await res.json().catch(() => null);
  if (mlListingPricesRawFullLogEnabled(item)) {
    console.info("[ML_LISTING_PRICES][raw_response_full]", {
      item_id: item?.id ?? null,
      request_url: url,
      http_status: res.status,
      http_ok: res.ok,
      omit_shipping_params: omitShippingParams,
      response_body: json,
    });
  }
  if (feeDbg) {
    const arrProbe = listingPricesArrayFromResponseJson(json);
    console.info(
      "[ML_FEE_DEBUG]",
      JSON.stringify({
        phase: "listing_prices_http_response",
        listing_id: item?.id ?? null,
        request_url: url,
        http_ok: res.ok,
        http_status: res.status,
        response_rows_count: arrProbe.length,
        response_body_snippet: jsonSnippet(json, 1800),
      })
    );
  }
  if (!res.ok) {
    if (debug) {
      console.info("[ML_LISTING_PRICES_HTTP][response]", {
        ok: false,
        http_status: res.status,
        item_id: item?.id ?? null,
        site_id: siteId,
        price_used: price,
        request_url: url,
        body_snippet: jsonSnippet(json, 2500),
      });
    }
    return {
      row: null,
      rawJson: json,
      requestUrl: url,
      httpStatus: res.status,
      httpOk: false,
      skipReason: "http_not_ok",
    };
  }
  const arr = listingPricesArrayFromResponseJson(json);
  if (arr.length === 0) {
    if (debug) {
      console.info("[ML_LISTING_PRICES_HTTP][response]", {
        ok: true,
        http_status: res.status,
        empty_utilizable_rows: true,
        item_id: item?.id ?? null,
        site_id: siteId,
        price_used: price,
        request_url: url,
        raw_top_level_type: json == null ? null : Array.isArray(json) ? "array" : typeof json,
        body_snippet: jsonSnippet(json, 2500),
      });
    }
    return {
      row: null,
      rawJson: json,
      requestUrl: url,
      httpStatus: res.status,
      httpOk: true,
      skipReason: "empty_utilizable_rows",
    };
  }

  const out = pickBestListingPricesRow(/** @type {Record<string, unknown>} */ (item), arr);
  if (mlListingPricesShippingAuditLogEnabled(item)) {
    console.info("[ML_LISTING_PRICES][shipping_audit]", {
      item_id: item?.id ?? null,
      request_url: url,
      http_status: res.status,
      http_ok: res.ok,
      omit_shipping_params: omitShippingParams,
      response_rows_count: arr.length,
      response_body_full: json,
      selected_row_full: out && typeof out === "object" ? out : null,
    });
  }
  if (mlFeeValidateLogsEnabled()) {
    const pickedProbe =
      out && typeof out === "object"
        ? extractSaleFee(
            listingPricesRowSynthForExtract(
              /** @type {Record<string, unknown>} */ (item),
              /** @type {Record<string, unknown>} */ (out)
            ),
            {
              deriveFromPercent: true,
              listing: /** @type {Record<string, unknown>} */ (item),
              skipDeepExtract: true,
            }
          )
        : { percent: null, amount: null };
    console.info("[ML_FEE_VALIDATE][listing_prices_selected_row]", {
      item_id: item?.id ?? null,
      site_id: siteId,
      rows_count: arr.length,
      picked_listing_type_id:
        out && typeof out === "object" ? /** @type {Record<string, unknown>} */ (out).listing_type_id ?? null : null,
      picked_mapping: out && typeof out === "object" ? /** @type {Record<string, unknown>} */ (out).mapping ?? null : null,
      extract_sale_fee_after_pick: pickedProbe,
      row_excerpt: listingPricesRowExcerptForPersist(out && typeof out === "object" ? /** @type {Record<string, unknown>} */ (out) : null),
    });
  }
  if (debug) {
    const pickedKeys =
      out && typeof out === "object"
        ? {
            listing_type_id: out.listing_type_id ?? null,
            mapping: out.mapping ?? null,
            sale_fee_amount: out.sale_fee_amount ?? null,
            selling_fee: out.selling_fee ?? null,
            sale_fee: out.sale_fee ?? null,
            has_sale_fee_details: Boolean(out.sale_fee_details),
            sale_fee_details_type:
              out.sale_fee_details == null
                ? null
                : Array.isArray(out.sale_fee_details)
                  ? "array"
                  : typeof out.sale_fee_details,
            sale_fee_details_snippet: jsonSnippet(out.sale_fee_details, 1200),
          }
        : null;
    const mergedProbe =
      out && typeof out === "object"
        ? extractSaleFee(
            {
              ...item,
              sale_fee_amount: coalescePositiveFeeAmount(out.sale_fee_amount, out.selling_fee, out.sale_fee),
              sale_fee_details: out.sale_fee_details ?? item.sale_fee_details,
            },
            {
              deriveFromPercent: false,
              listing: /** @type {Record<string, unknown>} */ (item),
              skipDeepExtract: true,
            }
          )
        : null;
    console.info("[ML_LISTING_PRICES_HTTP][response]", {
      ok: true,
      http_status: res.status,
      item_id: item?.id ?? null,
      site_id: siteId,
      item_site_id_field: item?.site_id ?? null,
      price_used: price,
      listing_type_id: item?.listing_type_id ?? null,
      category_id: item?.category_id ?? null,
      currency_id: item?.currency_id ?? null,
      logistic_type:
        item?.shipping && typeof item.shipping === "object"
          ? item.shipping.logistic_type ?? null
          : null,
      shipping_mode:
        item?.shipping && typeof item.shipping === "object" ? item.shipping.mode ?? null : null,
      request_url: url,
      rows_count: arr.length,
      picked_row: pickedKeys,
      picked_fee_extract_no_derive: mergedProbe,
    });
  }
  const rowOut = out && typeof out === "object" ? /** @type {Record<string, unknown>} */ (out) : null;
  return {
    row: rowOut,
    rawJson: json,
    requestUrl: url,
    httpStatus: res.status,
    httpOk: true,
    skipReason: rowOut == null ? "no_row_object" : null,
  };
}

/**
 * @param {string} accessToken
 * @param {Record<string, unknown>} item
 * @param {{ omitShippingParams?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchListingPricesRowForItem(accessToken, item, opts = {}) {
  const d = await fetchListingPricesForItemDetailed(accessToken, item, opts);
  return d.row;
}

/**
 * promotion_id / promotion_type podem vir no root ou dentro de `metadata` (doc Products prices).
 * @param {Record<string, unknown>} sp
 */
export function pickPromotionIdFromSalePricePayload(sp) {
  if (!sp || typeof sp !== "object") return null;
  const m =
    sp.metadata != null && typeof sp.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (sp.metadata)
      : null;
  const v = sp.promotion_id ?? (m ? m.promotion_id : null);
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

/**
 * @param {Record<string, unknown>} sp
 */
export function pickPromotionTypeFromSalePricePayload(sp) {
  if (!sp || typeof sp !== "object") return null;
  const m =
    sp.metadata != null && typeof sp.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (sp.metadata)
      : null;
  const v = sp.promotion_type ?? (m ? m.promotion_type : null);
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

/**
 * Preço de venda / pré-tiqueta — GET /items/:id/sale_price
 * Doc: https://developers.mercadolibre.com.ar/en_us/price-apl — usar `context` (ex.: channel_marketplace)
 * para metadados da promoção quando o token é do vendedor dono do item.
 *
 * @param {string} accessToken
 * @param {string} itemId
 * @param {{ context?: string | null }} [opts]
 */
export async function fetchItemSalePrice(accessToken, itemId, opts = {}) {
  const id = String(itemId ?? "").trim();
  if (!id) return null;
  const contextRaw =
    opts.context != null && String(opts.context).trim() !== ""
      ? String(opts.context).trim()
      : "channel_marketplace";
  const params = new URLSearchParams();
  params.set("context", contextRaw);
  const url = `${ML_API}/items/${encodeURIComponent(id)}/sale_price?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json !== "object") return null;
  return /** @type {Record<string, unknown>} */ (json);
}

/**
 * Detalhes da oferta/promoção — GET /seller-promotions/promotions/:id (Manage promotion).
 * Requer `promotion_type` (ex.: DEAL, MARKETPLACE_CAMPAIGN, PRICE_DISCOUNT…).
 *
 * @param {string} accessToken
 * @param {string} promotionId ex.: P-MLB…
 * @param {string} promotionType
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchSellerPromotionDetails(accessToken, promotionId, promotionType) {
  const pid = promotionId != null ? String(promotionId).trim() : "";
  const ptype = promotionType != null ? String(promotionType).trim() : "";
  if (!pid || !ptype || !accessToken) return null;
  const params = new URLSearchParams();
  params.set("promotion_type", ptype);
  params.set("app_version", "v2");
  const url = `${ML_API}/seller-promotions/promotions/${encodeURIComponent(pid)}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json !== "object") {
    if (mlFeeValidateLogsEnabled()) {
      console.info("[ML_SALE_PRICE_PROMOTION][fetch_promotion_failed]", {
        promotion_id: pid,
        promotion_type: ptype,
        http_status: res.status,
        body_snippet: jsonSnippet(json, 600),
      });
    }
    return null;
  }
  return /** @type {Record<string, unknown>} */ (json);
}

/**
 * Lista promoções de um item — GET /seller-promotions/items/:id?app_version=v2
 * (retorna campanhas ativas, programadas e candidatas no contexto do item).
 *
 * @param {string} accessToken
 * @param {string} itemId
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchSellerPromotionsByItem(accessToken, itemId) {
  const iid = itemId != null ? String(itemId).trim() : "";
  if (!iid || !accessToken) return [];
  const params = new URLSearchParams();
  params.set("app_version", "v2");
  const url = `${ML_API}/seller-promotions/items/${encodeURIComponent(iid)}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(json)) {
    if (mlFeeValidateLogsEnabled()) {
      console.info("[ML_SALE_PRICE_PROMOTION][fetch_item_promotions_failed]", {
        item_id: iid,
        http_status: res.status,
        body_snippet: jsonSnippet(json, 600),
      });
    }
    return [];
  }
  return /** @type {Record<string, unknown>[]} */ (json);
}

/**
 * Injeta sale_fee_* do listing_prices e, se necessário, original_price via sale_price.
 * @param {string} accessToken
 * @param {Record<string, unknown>} item
 * @param {{ healthSync?: boolean }} [opts] — `healthSync: true` força GET listing_prices mesmo quando o item já tem tarifa superficial (garante fonte oficial no persist de health).
 */
export async function enrichItemWithListingPricesFees(accessToken, item, opts = {}) {
  if (!item || typeof item !== "object") return item;
  if (!accessToken) {
    const out = {
      ...item,
      _suse7_fee_resolution: {
        listing_prices_called: false,
        gate_need_listing_prices: false,
        listing_prices_skip_reason: "no_access_token",
        listing_prices_http_attempted: false,
        listing_prices_row_received: false,
      },
    };
    if (mlFeeDebugEnabled()) {
      console.info(
        "[ML_FEE_DEBUG]",
        JSON.stringify({
          phase: "enrich_skip",
          listing_id: item?.id ?? null,
          skip_reason: "missing_token",
          has_listing_prices: false,
          listing_prices_row: null,
          sale_fee_amount_calculated: null,
          sale_fee_percent_calculated: null,
          persisted_sale_fee_amount: null,
          persisted_sale_fee_percent: null,
        })
      );
    }
    return out;
  }

  let next = item;
  /** @type {Record<string, unknown> | null} */
  let salePriceFetched = null;
  const skipSalePrice = process.env.ML_SKIP_SALE_PRICE === "1";

  if (!skipSalePrice && item.id != null) {
    try {
      const saleCtx = "channel_marketplace";
      const sp = await fetchItemSalePrice(accessToken, String(item.id), { context: saleCtx });
      if (sp && typeof sp === "object") {
        salePriceFetched = sp;
        next = { ...item };
        const meta =
          sp.metadata != null && typeof sp.metadata === "object"
            ? /** @type {Record<string, unknown>} */ (sp.metadata)
            : null;
        const promId = pickPromotionIdFromSalePricePayload(sp);
        const promType = pickPromotionTypeFromSalePricePayload(sp);
        next._suse7_sale_price_snapshot = {
          amount: sp.amount ?? null,
          regular_amount: sp.regular_amount ?? null,
          currency_id: sp.currency_id ?? null,
          price_id: sp.price_id ?? null,
          reference_date: sp.reference_date ?? null,
          promotion_id: promId,
          promotion_type: promType,
          metadata: meta,
          context_used: saleCtx,
        };
        if (promId && promType) {
          try {
            const promDet = await fetchSellerPromotionDetails(accessToken, promId, promType);
            if (promDet && typeof promDet === "object") {
              next._suse7_seller_promotion_details = promDet;
            }
          } catch {
            /* detalhe opcional — token/site pode não permitir */
          }
        }
        // Não sobrescrever item.price/original_price com sale_price snapshot.
        // Esse snapshot pode ficar desatualizado e contaminar base oficial do cálculo líquido.
      }
    } catch {
      /* sale_price opcional */
    }
  }

  if (mlPriceValidateLogsEnabled()) {
    const spMeta =
      salePriceFetched &&
      salePriceFetched.metadata != null &&
      typeof salePriceFetched.metadata === "object"
        ? /** @type {Record<string, unknown>} */ (salePriceFetched.metadata)
        : null;
    console.info("[ML_PRICE_VALIDATE][source_prices]", {
      item_id: item?.id ?? null,
      item_original_price: item?.original_price ?? null,
      item_price: item?.price ?? null,
      sale_price_amount: salePriceFetched?.amount ?? null,
      sale_price_regular_amount: salePriceFetched?.regular_amount ?? null,
      sale_price_context: "channel_marketplace",
      sale_price_promotion_id:
        salePriceFetched != null ? pickPromotionIdFromSalePricePayload(salePriceFetched) : null,
      sale_price_promotion_type:
        salePriceFetched != null ? pickPromotionTypeFromSalePricePayload(salePriceFetched) : null,
      sale_price_metadata_promotion_id: spMeta?.promotion_id ?? null,
      sale_price_metadata_promotion_type: spMeta?.promotion_type ?? null,
    });
  }

  const promoEff = extractPromotionPrice(next);
  const rootPx = toFiniteNumber(next.price);
  const listPxForRule =
    toFiniteNumber(next.original_price) ??
    toFiniteNumber(next.base_price) ??
    rootPx;
  /** Mesma regra que o motor financeiro: comissão / listing_prices sobre sale_price_effective (domain/pricing). */
  let priceForFees;
  const lp =
    listPxForRule != null && listPxForRule > 0
      ? listPxForRule
      : rootPx != null && rootPx > 0
        ? rootPx
        : 0;
  if (lp > 0) {
    const hasPromo = promoEff != null && promoEff > 0 && promoEff < lp;
    const resolvedFees = resolveMercadoLivreSalePriceOfficial({
      marketplace: "mercado_livre",
      listing_id: next?.id != null ? String(next.id) : null,
      listing_price: lp,
      promotion_price: promoEff,
      has_active_promotion_hint: hasPromo,
      context: "enrich_listing_prices_query",
    });
    priceForFees =
      resolvedFees.sale_price_effective != null
        ? Number(resolvedFees.sale_price_effective)
        : null;
    if (priceForFees == null) {
      priceForFees =
        promoEff != null && promoEff > 0 ? promoEff : rootPx != null && rootPx > 0 ? rootPx : null;
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.PRICING_FALLBACK_APPLIED, {
        marketplace: "mercado_livre",
        listing_id: next?.id != null ? String(next.id) : null,
        context: "enrich_listing_prices_price_for_fees",
        message: "Resolver sem sale_price_effective — fallback promo/root na query listing_prices",
      });
    }
  } else {
    priceForFees =
      promoEff != null && promoEff > 0 ? promoEff : rootPx != null && rootPx > 0 ? rootPx : null;
    if (priceForFees == null) {
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.INVALID_LISTING_PRICE, {
        marketplace: "mercado_livre",
        listing_id: next?.id != null ? String(next.id) : null,
        context: "enrich_listing_prices_no_listing_base",
        listing_price_raw: listPxForRule,
        message: "Sem listing base positiva para resolver preço da consulta listing_prices",
      });
    }
  }
  const itemForFees =
    priceForFees != null && Number.isFinite(priceForFees) && priceForFees > 0
      ? { ...next, price: priceForFees }
      : next;

  /** Só “amount explícito” (root ou details); não derivar %×preço — evita pular listing_prices com % espúrio. */
  /** Sem deep extract: senão um número qualquer no JSON do item pode fingir “tarifa” e pular listing_prices. */
  const curSolid = extractSaleFee(itemForFees, {
    deriveFromPercent: false,
    listing: /** @type {Record<string, unknown>} */ (item),
    skipDeepExtract: true,
  });
  /** Sync de `marketplace_listing_health` sempre consulta listing_prices quando há token (tarifa oficial). */
  const forceOfficialListingPrices = opts.healthSync === true;
  const needListingPrices =
    forceOfficialListingPrices ||
    curSolid.amount == null ||
    curSolid.amount <= 0;

  const debug = mlListingFeeDebugEnabled(item);
  const validate = mlFeeValidateLogsEnabled();

  if (validate || debug) {
    console.info("[ML_FEE_VALIDATE][listing_prices_decision]", {
      item_id: item?.id ?? null,
      skip_deep_extract: true,
      extract_sale_fee_surface_no_derive: curSolid,
      health_sync_forced_listing_prices: forceOfficialListingPrices,
      need_listing_prices: needListingPrices,
      reason: needListingPrices
        ? forceOfficialListingPrices
          ? "health_sync_requires_official_listing_prices"
          : "no_positive_fee_amount_on_item_surface"
        : "surface_fee_present_listing_prices_not_required",
    });
  }

  if (debug) {
    console.info("[ML_ENRICH_LISTING_PRICES][before_fetch]", {
      external_listing_id: item?.id != null ? String(item.id) : null,
      item_id: item?.id ?? null,
      site_id: item?.site_id ?? null,
      price_root: item?.price ?? null,
      price_for_listing_prices_query: itemForFees?.price ?? null,
      promo_effective: promoEff,
      extract_sale_fee_no_derive: curSolid,
      need_listing_prices: needListingPrices,
    });
  }

  /** @type {boolean} */
  let lpTry1HadFee = false;
  /** @type {boolean} */
  let lpUsedMinimalFallback = false;
  /** @type {boolean} */
  let lpHttpAttempted = false;
  /** @type {boolean} */
  let lpRowReceived = false;
  /** @type {string | null} */
  let lpSkipReason = null;

  if (needListingPrices) {
    const siteForLp =
      itemForFees.site_id != null && String(itemForFees.site_id).trim() !== ""
        ? String(itemForFees.site_id).trim()
        : itemForFees.id != null
          ? (() => {
              const m = String(itemForFees.id).match(/^([A-Z]{3})\d/i);
              return m ? m[1].toUpperCase() : "";
            })()
          : "";
    const priceForLp = itemForFees.price != null ? Number(itemForFees.price) : NaN;
    if (!siteForLp) {
      lpSkipReason = "missing_site_id";
    } else if (!Number.isFinite(priceForLp) || priceForLp <= 0) {
      lpSkipReason = "missing_or_invalid_price";
    }

    if (lpSkipReason && (process.env.ML_SYNC_FEE_LINE_LOG === "1" || validate || debug)) {
      console.warn("[ML_LISTING_PRICES][skip_before_http]", {
        item_id: item?.id ?? null,
        reason: lpSkipReason,
        site_id: siteForLp || null,
        price: Number.isFinite(priceForLp) ? priceForLp : null,
      });
    }
  }

  if (needListingPrices && !lpSkipReason) {
    lpHttpAttempted = true;
    /** @type {Record<string, unknown> | null} */
    let row = null;
    try {
      /** @param {{ requestUrl: string | null; httpStatus: number | null; httpOk: boolean; skipReason: string | null; rawJson: unknown }} det */
      const attachListingPricesHttpRaw = (det, attempt, omitSp) => {
        next = next === item ? { ...item } : next;
        next._suse7_listing_prices_http_raw = {
          attempt,
          omit_shipping_params: omitSp,
          request_url: det.requestUrl,
          http_status: det.httpStatus,
          http_ok: det.httpOk,
          skip_reason: det.skipReason,
          response_body: det.rawJson,
        };
      };

      const lpDet1 = await fetchListingPricesForItemDetailed(accessToken, itemForFees);
      row = lpDet1.row;
      attachListingPricesHttpRaw(lpDet1, 1, false);
      let feeAfterMerge =
        row && typeof row === "object"
          ? coalesceListingPricesPersistedFeeAmount(/** @type {Record<string, unknown>} */ (row)) ??
            coalescePositiveFeeAmount(row.sale_fee_amount, row.selling_fee, row.sale_fee)
          : null;
      if (
        feeAfterMerge == null &&
        row &&
        typeof row === "object" &&
        row.sale_fee_details != null
      ) {
        const probe = extractSaleFee(
          {
            ...itemForFees,
            sale_fee_details: row.sale_fee_details,
            sale_fee_amount: row.sale_fee_amount,
          },
          {
            deriveFromPercent: false,
            listing: /** @type {Record<string, unknown>} */ (item),
            skipDeepExtract: true,
          }
        );
        if (probe.amount != null && probe.amount > 0) feeAfterMerge = probe.amount;
      }
      lpTry1HadFee = feeAfterMerge != null && feeAfterMerge > 0;

      if (validate || debug) {
        console.info("[ML_FEE_VALIDATE][listing_prices_try1_full_params]", {
          item_id: item?.id ?? null,
          had_row: row != null && typeof row === "object",
          fee_coalesced_positive: lpTry1HadFee,
          row_listing_type_id:
            row && typeof row === "object" ? row.listing_type_id ?? row.mapping ?? null : null,
        });
      }

      if ((row == null || feeAfterMerge == null) && typeof itemForFees === "object") {
        lpUsedMinimalFallback = true;
        const lpDet2 = await fetchListingPricesForItemDetailed(accessToken, itemForFees, {
          omitShippingParams: true,
        });
        attachListingPricesHttpRaw(lpDet2, 2, true);
        const rowMinimal = lpDet2.row;
        if (validate || debug) {
          console.info("[ML_FEE_VALIDATE][listing_prices_try2_omit_shipping_params]", {
            item_id: item?.id ?? null,
            had_row: rowMinimal != null && typeof rowMinimal === "object",
            fee_coalesced_positive:
              rowMinimal != null && typeof rowMinimal === "object"
                ? coalescePositiveFeeAmount(
                    rowMinimal.sale_fee_amount,
                    rowMinimal.selling_fee,
                    rowMinimal.sale_fee
                  ) != null
                : false,
          });
        }
        if (rowMinimal && typeof rowMinimal === "object") {
          row = rowMinimal;
          feeAfterMerge =
            coalesceListingPricesPersistedFeeAmount(/** @type {Record<string, unknown>} */ (rowMinimal)) ??
            coalescePositiveFeeAmount(
              rowMinimal.sale_fee_amount,
              rowMinimal.selling_fee,
              rowMinimal.sale_fee
            );
          if (feeAfterMerge == null && rowMinimal.sale_fee_details != null) {
            const probeMin = extractSaleFee(
              {
                ...itemForFees,
                sale_fee_details: rowMinimal.sale_fee_details,
                sale_fee_amount: rowMinimal.sale_fee_amount,
              },
              {
                deriveFromPercent: false,
                listing: /** @type {Record<string, unknown>} */ (item),
                skipDeepExtract: true,
              }
            );
            if (probeMin.amount != null && probeMin.amount > 0) feeAfterMerge = probeMin.amount;
          }
        }
      }
      if (row && typeof row === "object") {
        lpRowReceived = true;
        next = next === item ? { ...item } : next;
        const feeAmt =
          coalesceListingPricesPersistedFeeAmount(row) ??
          coalescePositiveFeeAmount(row.sale_fee_amount, row.selling_fee, row.sale_fee);
        if (feeAmt != null) next.sale_fee_amount = feeAmt;
        if (row.sale_fee_details != null) next.sale_fee_details = row.sale_fee_details;
        const rowRec = /** @type {Record<string, unknown>} */ (row);
        next._suse7_listing_prices_row_excerpt = listingPricesRowExcerptForPersist(rowRec);
        next._suse7_listing_prices_row_persist = listingPricesRowForHealthPersist(rowRec);
        const officialFeeExtract = extractOfficialMercadoLibreListingPricesFee(rowRec);
        if (validate || debug) {
          console.info("[ML_ENRICH_LISTING_PRICES][official_fee_extract]", {
            item_id: item?.id ?? null,
            sale_fee_amount: officialFeeExtract.amount,
            sale_fee_percent: officialFeeExtract.percent,
          });
          if (officialFeeExtract.amount == null && officialFeeExtract.percent == null) {
            console.warn("[ML_ENRICH_LISTING_PRICES][listing_prices_row_no_fee]", {
              item_id: item?.id ?? null,
              has_sale_fee_details: Boolean(rowRec.sale_fee_details),
            });
          }
        }
      }

      if (validate || debug) {
        console.info("[ML_FEE_VALIDATE][listing_prices_payload]", {
          item_id: item?.id ?? null,
          need_listing_prices: needListingPrices,
          had_row: row != null && typeof row === "object",
          row_persist_keys:
            row && typeof row === "object"
              ? Object.keys(/** @type {Record<string, unknown>} */ (row)).slice(0, 24)
              : [],
          excerpt: row && typeof row === "object" ? listingPricesRowExcerptForPersist(/** @type {Record<string, unknown>} */ (row)) : null,
        });
      }
      if (debug) {
        const after = extractSaleFee(next, {
          deriveFromPercent: true,
          listing: /** @type {Record<string, unknown>} */ (item),
        });
        console.info("[ML_ENRICH_LISTING_PRICES][after_fetch]", {
          external_listing_id: next?.id != null ? String(next.id) : null,
          item_id: next?.id ?? null,
          merged_sale_fee_amount: next.sale_fee_amount ?? null,
          has_sale_fee_details: Boolean(next.sale_fee_details),
          extract_sale_fee_full_derived: after,
          extract_shipping_cost_from_item: extractShippingCost(next),
          listing_prices_row_missing: row == null || typeof row !== "object",
        });
      }
    } catch (e) {
      lpSkipReason = "listing_prices_fetch_exception";
      if (debug || validate) {
        console.info("[ML_ENRICH_LISTING_PRICES][fetch_error]", {
          item_id: item?.id ?? null,
          message: e?.message ? String(e.message) : String(e),
        });
      }
      /* ignore listing_prices failures — health segue só com item */
    }
    if (lpHttpAttempted && !lpRowReceived && !lpTry1HadFee && !lpSkipReason) {
      lpSkipReason = "listing_prices_empty_or_unparseable";
    }
  } else if (debug) {
    if (!needListingPrices) {
      console.info("[ML_ENRICH_LISTING_PRICES][skipped_already_has_fee_amount]", {
        item_id: item?.id ?? null,
        cur_solid: curSolid,
      });
    } else if (lpSkipReason) {
      console.info("[ML_ENRICH_LISTING_PRICES][listing_prices_skipped]", {
        item_id: item?.id ?? null,
        reason: lpSkipReason,
      });
    }
  }

  /** Endpoint oficial de frete seller (canônico) — habilitado no fluxo de health sync. */
  if (opts.healthSync === true && itemForFees && typeof itemForFees === "object") {
    try {
      const so = await fetchSellerShippingOptionsFree(
        accessToken,
        /** @type {Record<string, unknown>} */ (itemForFees)
      );
      if (so.payload != null || so.amount != null) {
        next = next === item ? { ...item } : next;
        if (so.amount != null && so.amount > 0) {
          next._suse7_shipping_options_free_amount = so.amount;
        }
        if (so.payload != null && typeof so.payload === "object") {
          next._suse7_shipping_options_free_persist = so.payload;
        }
      }
    } catch {
      /* opcional para sync; não bloqueia pipeline */
    }
  }

  const afterEnrich = extractSaleFee(
    next === item ? /** @type {Record<string, unknown>} */ (item) : /** @type {Record<string, unknown>} */ (next),
    {
      deriveFromPercent: true,
      listing: /** @type {Record<string, unknown>} */ (item),
    }
  );
  /** @type {Record<string, unknown>} */
  const feeResolution = {
    health_sync_forced_listing_prices: forceOfficialListingPrices,
    gate_need_listing_prices: needListingPrices,
    listing_prices_official_called: needListingPrices,
    listing_prices_http_attempted: lpHttpAttempted,
    listing_prices_skip_reason: lpSkipReason,
    listing_prices_row_received: lpRowReceived,
    try1_had_utilizable_fee: lpTry1HadFee,
    used_minimal_shipping_fallback: lpUsedMinimalFallback,
    source:
      !needListingPrices
        ? "item"
        : lpTry1HadFee
          ? "listing_prices"
          : lpUsedMinimalFallback
            ? "listing_prices_no_shipping_params"
            : afterEnrich.amount != null && afterEnrich.amount > 0
              ? "listing_prices"
              : "insufficient_data",
  };

  const base = next === item ? { ...item } : { ...next };
  return { ...base, _suse7_fee_resolution: feeResolution };
}

/**
 * Recurso oficial de foto quando o item só lista `id` (sem secure_url no array).
 * @param {string} accessToken
 * @param {string} pictureId — ex.: "963513-MLB49868862376_052022"
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchMlPictureById(accessToken, pictureId) {
  const id = String(pictureId).trim();
  if (!id) return null;
  const url = `${ML_API}/pictures/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json || typeof json !== "object" || Array.isArray(json)) return null;
  return /** @type {Record<string, unknown>} */ (json);
}

/**
 * Para cada entrada de `pictures` sem URL no nível raiz, chama GET /pictures/:id e preenche `secure_url`.
 * @param {string} accessToken
 * @param {unknown[]} pictures
 * @param {(msg: string, extra?: object) => void} [log]
 * @returns {Promise<unknown[]>}
 */
export async function hydrateMlItemPicturesWithPictureApi(accessToken, pictures, log = () => {}) {
  if (!Array.isArray(pictures) || pictures.length === 0) return pictures;
  /** @type {unknown[]} */
  const out = [];
  for (const p of pictures) {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      out.push(p);
      continue;
    }
    const po = /** @type {Record<string, unknown>} */ (p);
    if (extractMlPictureHttpFromObject(po)) {
      out.push(p);
      continue;
    }
    const pid = po.id != null ? String(po.id).trim() : "";
    if (!pid) {
      out.push(p);
      continue;
    }
    try {
      const resource = await fetchMlPictureById(accessToken, pid);
      const url = resource ? extractMlPictureHttpFromObject(resource) : null;
      if (url) {
        out.push({ ...po, secure_url: url });
        continue;
      }
    } catch (e) {
      log("picture_resource_fetch_failed", { picture_id: pid, message: e?.message });
    }
    out.push(p);
  }
  return out;
}

/**
 * Atualiza preço de venda do anúncio — PUT /items/:id (atualização parcial ML).
 * Futuro: itens só com variação podem exigir contrato diferente.
 *
 * @param {string} accessToken
 * @param {string} itemId — MLB…
 * @param {number | string} price
 * @returns {Promise<Record<string, unknown>>}
 */
export async function putMercadoLibreItemPrice(accessToken, itemId, price) {
  const id = String(itemId ?? "").trim();
  if (!id) {
    const err = new /** @type {Error & { status?: number; body?: unknown }} */ (Error)("itemId vazio");
    err.status = 400;
    throw err;
  }
  const n = typeof price === "number" ? price : Number(String(price).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) {
    const err = new /** @type {Error & { status?: number; body?: unknown }} */ (Error)("Preço inválido");
    err.status = 400;
    throw err;
  }
  const url = `${ML_API}/items/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ price: n }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json?.message != null
        ? String(json.message)
        : json?.error != null
          ? String(json.error)
          : `ML put item HTTP ${res.status}`;
    const err = new Error(msg);
    /** @type {Error & { status?: number; body?: unknown }} */
    const e = /** @type {any} */ (err);
    e.status = res.status;
    e.body = json;
    throw err;
  }
  return /** @type {Record<string, unknown>} */ (json);
}

