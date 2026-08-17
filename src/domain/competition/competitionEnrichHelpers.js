// ============================================================
// S7 — Concorrência: helpers de enrich, patch e logs DEV
// ============================================================

import { competitionSalesAuditEnabled } from "./competitionSalesMlAudit.js";

const SLUG_STOPWORDS = new Set([
  "teste",
  "novo",
  "nova",
  "original",
  "frete",
  "gratis",
  "grátis",
  "envio",
  "full",
  "ml",
  "mercado",
  "livre",
  "br",
  "com",
  "de",
  "da",
  "do",
  "para",
  "com",
]);

/**
 * Gera queries de busca no catálogo a partir do permalink e título conhecido.
 * @param {string | null} permalink
 * @param {string | null} [titleHint]
 */
export function buildCatalogSearchQueries(permalink, titleHint = null, listingId = null) {
  const queries = [];
  const seen = new Set();
  const push = (q) => {
    const s = String(q || "").trim().toLowerCase();
    if (s.length < 3 || seen.has(s)) return;
    seen.add(s);
    queries.push(String(q).trim().slice(0, 120));
  };

  if (listingId) {
    push(String(listingId).trim());
    const digits = String(listingId).replace(/^ML[ABCU]/i, "").trim();
    if (digits.length >= 6) push(digits);
  }

  if (titleHint) push(titleHint);

  if (permalink) {
    try {
      const u = new URL(String(permalink).startsWith("http") ? permalink : `https://${permalink}`);
      const path = decodeURIComponent(u.pathname);

      let m = path.match(/ML[ABCU]-?\d{6,}-(.+)/i);
      if (m?.[1]) push(m[1].replace(/-/g, " "));

      m = path.match(/^\/([^/]+)\/p\/ML[ABCU]/i);
      if (m?.[1]) push(m[1].replace(/-/g, " "));

      const words = path
        .replace(/\/p\/ML[ABCU]\d+/gi, " ")
        .replace(/ML[ABCU]-?\d{6,}-?/gi, " ")
        .replace(/[/_-]/g, " ")
        .split(/\s+/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 2 && !SLUG_STOPWORDS.has(w));

      if (words.length >= 2) {
        push(words.join(" "));
        for (let n = 2; n <= Math.min(4, words.length); n++) {
          for (let i = 0; i <= words.length - n; i++) {
            push(words.slice(i, i + n).join(" "));
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  return queries.slice(0, 8);
}

/**
 * Mescla patch sem apagar campos já preenchidos com null/undefined.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} patch
 */
export function mergeNonemptyCompetitorPatch(base, patch) {
  const out = { ...(base && typeof base === "object" ? base : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === "") continue;
    out[k] = v;
  }
  return out;
}

/** Campos permitidos no patch de persistência (nunca mesclar row inteira do banco). */
export function buildCompetitorSavePatch({ accountId, companyId, sku, sourceStrategy, normalized }) {
  const base = {
    marketplace_account_id: accountId,
    seller_company_id: companyId,
    sku,
    source_strategy: sourceStrategy || "ml_link",
    is_active: true,
  };
  const data = {
    competitor_title: normalized.competitor_title,
    competitor_seller_id: normalized.competitor_seller_id,
    competitor_store_name: normalized.competitor_store_name,
    competitor_permalink: normalized.competitor_permalink,
    competitor_thumbnail: normalized.competitor_thumbnail,
    last_seen_price: normalized.last_seen_price,
    last_seen_currency: normalized.last_seen_currency,
    competitor_listing_status: normalized.competitor_listing_status ?? null,
  };
  const patch = mergeNonemptyCompetitorPatch(base, data);
  if (normalized.last_seen_price != null) {
    patch.last_captured_at = new Date().toISOString();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "competitor_listing_status")) {
    if (normalized.competitor_listing_status == null || normalized.competitor_listing_status === "") {
      patch.competitor_listing_status = null;
    }
  }
  return patch;
}

export const INCOMPLETE_LINK_SAVE_MESSAGE =
  "Não foi possível obter os dados completos desse concorrente. Tente outro link ou atualize novamente.";

const FATAL_LINK_CODES = new Set([
  "link_unresolved",
  "own_listing",
  "ml_token_unavailable",
  "url_empty",
  "url_invalid",
  "not_mercado_livre",
  "link_slug_ambiguous",
]);

export function isFatalLinkResolveCode(code) {
  return FATAL_LINK_CODES.has(String(code || ""));
}

/** Preview mínimo: item_id + (título ou permalink). */
export function isPreviewResolvableCandidate(candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const id = c.competitor_listing_id;
  const title = c.competitor_title;
  const permalink = c.competitor_permalink;
  return Boolean(id && (title || permalink));
}

/** Campos desejáveis para enrich completo (não bloqueiam cadastro). */
export function listEnrichDesiredMissingFields(candidateOrRow) {
  const c = candidateOrRow && typeof candidateOrRow === "object" ? candidateOrRow : {};
  const missing = [];
  if (!c.competitor_thumbnail) missing.push("thumbnail");
  const price = c.competitor_price ?? c.last_seen_price;
  if (price == null) missing.push("price");
  if (!c.competitor_store_name) missing.push("seller_nickname");
  return missing;
}

/** Calcula enrich_status: complete | partial | failed */
export function computeEnrichStatus(row, extras = {}) {
  const r = row && typeof row === "object" ? row : {};
  const snapThumb = extras.snapshot_thumbnail ?? null;
  const snapStore = extras.snapshot_store_name ?? null;
  const snapPrice = extras.snapshot_price ?? null;

  const view = {
    competitor_listing_id: r.competitor_listing_id ?? null,
    competitor_title: r.competitor_title ?? extras.snapshot_title ?? null,
    competitor_permalink: r.competitor_permalink ?? null,
    competitor_thumbnail: r.competitor_thumbnail ?? snapThumb ?? null,
    competitor_price: r.last_seen_price ?? snapPrice ?? null,
    competitor_store_name: r.competitor_store_name ?? snapStore ?? null,
  };

  if (!view.competitor_listing_id) {
    return {
      enrich_status: "failed",
      enrich_missing_fields: ["listing_id"],
      last_enrich_error: extras.last_enrich_error ?? null,
    };
  }
  if (!view.competitor_title && !view.competitor_permalink) {
    return {
      enrich_status: "failed",
      enrich_missing_fields: ["title", "permalink"],
      last_enrich_error: extras.last_enrich_error ?? null,
    };
  }

  const desiredMissing = listEnrichDesiredMissingFields(view);
  if (desiredMissing.length === 0) {
    return { enrich_status: "complete", enrich_missing_fields: [], last_enrich_error: null };
  }
  return {
    enrich_status: "partial",
    enrich_missing_fields: desiredMissing,
    last_enrich_error: extras.last_enrich_error ?? null,
  };
}

/** Campos obrigatórios do card saudável (candidato discover). */
export function listMissingRequiredCardFieldsFromCandidate(candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const missing = [];
  if (!c.competitor_title) missing.push("title");
  if (!c.competitor_thumbnail) missing.push("thumbnail");
  if (c.competitor_price == null) missing.push("price");
  if (!c.competitor_store_name) missing.push("seller_nickname");
  if (!c.competitor_permalink) missing.push("permalink");
  return missing;
}

/** Campos obrigatórios do card saudável (normalized de persistência). */
export function listMissingRequiredCardFieldsFromNormalized(normalized) {
  const n = normalized && typeof normalized === "object" ? normalized : {};
  const missing = [];
  if (!n.competitor_title) missing.push("title");
  if (!n.competitor_thumbnail) missing.push("thumbnail");
  if (n.last_seen_price == null) missing.push("price");
  if (!n.competitor_store_name) missing.push("seller_nickname");
  if (!n.competitor_permalink) missing.push("permalink");
  return missing;
}

export function assessLinkCandidateHealth(candidate) {
  const missing = listMissingRequiredCardFieldsFromCandidate(candidate);
  return {
    healthy: missing.length === 0,
    missing_required_fields: missing,
    has_title: Boolean(candidate?.competitor_title),
    has_price: candidate?.competitor_price != null,
    has_thumbnail: Boolean(candidate?.competitor_thumbnail),
    has_seller_nickname: Boolean(candidate?.competitor_store_name),
    has_permalink: Boolean(candidate?.competitor_permalink),
    has_listing_type: Boolean(candidate?.listing_type),
    has_frete_hint: Boolean(
      candidate?.shipping?.free_shipping === true ||
        candidate?.shipping?.mode ||
        candidate?.shipping?.logistic_type
    ),
    has_seller_reputation: Boolean(
      candidate?.reputation?.level_id || candidate?.reputation?.power_seller_status
    ),
  };
}

export function logLinkParseResult(payload) {
  console.info("[S7_COMPETITION_LINK_PARSE_RESULT]", payload);
}

export function logLinkItemFetchResult(payload) {
  console.info("[S7_COMPETITION_LINK_ITEM_FETCH_RESULT]", payload);
}

export function logLinkSellerFetchResult(payload) {
  console.info("[S7_COMPETITION_LINK_SELLER_FETCH_RESULT]", payload);
}

export function logLinkFinalContract(payload) {
  console.info("[S7_COMPETITION_LINK_FINAL_CONTRACT]", payload);
}

export function logLinkResolveStep(payload) {
  console.info("[S7_COMPETITION_LINK_RESOLVE_STEP]", payload);
}

export function logLinkDiscoveryFallback(payload) {
  console.info("[S7_COMPETITION_LINK_DISCOVERY_FALLBACK]", payload);
}

export function logSaveBlockedIncomplete(payload) {
  console.info("[S7_COMPETITION_SAVE_BLOCKED_INCOMPLETE]", payload);
}

/** Normaliza quantidade de vendas (> 0) ou null. */
export function normalizeSalesHintValue(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/** Lê vendas dos aliases conhecidos em um objeto. */
export function pickSalesHintFromRecord(record) {
  if (!record || typeof record !== "object") return null;
  for (const key of ["sales_hint", "sold_quantity", "sold_quantity_value", "total_sold", "sales"]) {
    const n = normalizeSalesHintValue(record[key]);
    if (n != null) return n;
  }
  const soldText = record.sold_quantity_text;
  if (soldText != null && String(soldText).trim() !== "") {
    const m = String(soldText).match(/(\d[\d.\s]*)/);
    if (m) {
      const n = Number(m[1].replace(/\./g, "").replace(/\s/g, ""));
      if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    }
  }
  return null;
}

/** Preserva o maior valor de vendas conhecido (nunca inventa). */
export function mergeSalesHintPreserve(...sources) {
  let best = null;
  for (const src of sources) {
    const n =
      src != null && typeof src === "object"
        ? pickSalesHintFromRecord(src)
        : normalizeSalesHintValue(src);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best;
}

/** Auditoria ponta a ponta — onde as vendas existem ou somem (somente DEV ou S7_COMPETITION_SALES_AUDIT=1). */
export function logSalesAudit(stage, data = {}) {
  if (!competitionSalesAuditEnabled()) return;
  const record = data && typeof data === "object" ? data : {};
  console.info("[S7_COMPETITION_SALES_AUDIT]", {
    stage,
    item_id: record.item_id ?? record.competitor_listing_id ?? null,
    candidate_sales_hint: record.candidate_sales_hint ?? pickSalesHintFromRecord(record.candidate) ?? null,
    candidate_sold_quantity: record.candidate_sold_quantity ?? record.candidate?.sold_quantity ?? null,
    payload_sales_hint: record.payload_sales_hint ?? null,
    enrich_sales_hint: record.enrich_sales_hint ?? null,
    snapshot_sales_hint: record.snapshot_sales_hint ?? null,
    response_sales_hint: record.response_sales_hint ?? record.sales_hint ?? null,
    competitor_id: record.competitor_id ?? null,
    layer: record.layer ?? null,
  });
}

export function logSaveNormalizedFields(payload) {
  console.info("[S7_COMPETITION_SAVE_NORMALIZED_FIELDS]", payload);
}

export function logResponseSalesHint(payload) {
  if (!competitionSalesAuditEnabled()) return;
  console.info("[S7_COMPETITION_RESPONSE_SALES_HINT]", payload);
}

/**
 * Preserva loja e vendas do payload original após enrich/discovery.
 * @param {object} normalized
 * @param {object} enrichExtras
 * @param {object} bodyExtras — saída de enrichExtrasFromSaveBody
 */
export function preservePayloadFieldsAfterEnrich(normalized, enrichExtras, bodyExtras = {}) {
  const n = { ...(normalized && typeof normalized === "object" ? normalized : {}) };
  const extras = { ...(enrichExtras && typeof enrichExtras === "object" ? enrichExtras : {}) };
  const body = bodyExtras && typeof bodyExtras === "object" ? bodyExtras : {};
  let storeSource = null;

  if (!n.competitor_store_name && body.payload_store_name) {
    n.competitor_store_name = body.payload_store_name;
    storeSource = "payload";
  }

  extras.sales_hint = mergeSalesHintPreserve(extras, body, extras.sales_hint, body.sales_hint);

  const bodyShip = body.shipping && typeof body.shipping === "object" ? body.shipping : null;
  const extraShip = extras.shipping && typeof extras.shipping === "object" ? extras.shipping : {};
  if (
    bodyShip &&
    (bodyShip.free_shipping === true || bodyShip.mode || bodyShip.logistic_type) &&
    !extraShip.free_shipping &&
    !extraShip.mode &&
    !extraShip.logistic_type
  ) {
    extras.shipping = bodyShip;
  }

  if (!extras.listing_type && body.listing_type) extras.listing_type = body.listing_type;

  const bodyRep = body.reputation && typeof body.reputation === "object" ? body.reputation : null;
  const extraRep = extras.reputation && typeof extras.reputation === "object" ? extras.reputation : {};
  if (
    bodyRep &&
    (bodyRep.level_id || bodyRep.power_seller_status) &&
    !extraRep.level_id &&
    !extraRep.power_seller_status
  ) {
    extras.reputation = bodyRep;
  }

  return { normalized: n, enrichExtras: extras, storeSource };
}

/** Campos críticos antes de persistir concorrente (link ou busca). */
export function listMissingCriticalPersistFields(normalized) {
  return listMissingRequiredCardFieldsFromNormalized(normalized).map((f) =>
    f === "seller_nickname" ? "store_name" : f
  );
}

export function listMissingCriticalMetaFields(extras) {
  const e = extras && typeof extras === "object" ? extras : {};
  const missing = [];
  const shipping = e.shipping && typeof e.shipping === "object" ? e.shipping : null;
  if (!shipping || (shipping.free_shipping !== true && !shipping.mode && !shipping.logistic_type)) {
    missing.push("frete_hint");
  }
  if (!e.listing_type) missing.push("listing_type");
  const rep = e.reputation && typeof e.reputation === "object" ? e.reputation : null;
  if (!rep?.level_id && !rep?.power_seller_status) missing.push("seller_reputation");
  return missing;
}

export function isEnrichResultComplete(normalized, extras) {
  return (
    listMissingCriticalPersistFields(normalized).length === 0 &&
    listMissingCriticalMetaFields(extras).length === 0
  );
}

/** Enrich com limite de tempo — não bloqueia cadastro. */
export async function enrichWithTimeout(enrichFn, timeoutMs = 12000) {
  let timer = null;
  try {
    return await Promise.race([
      enrichFn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("enrich_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resumo seguro do raw enriquecido para logs DEV.
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function summarizeEnrichRawForLog(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const shipping = r.shipping && typeof r.shipping === "object" ? r.shipping : null;
  return {
    title: r.competitor_title ?? null,
    price: r.competitor_price ?? null,
    thumbnail: r.competitor_thumbnail ? "yes" : null,
    seller_id: r.competitor_seller_id ?? null,
    seller_nickname: r.competitor_store_name ?? null,
    permalink: r.competitor_permalink ?? null,
    listing_type: r.listing_type ?? null,
    free_shipping: shipping?.free_shipping === true ? true : null,
    sales_hint: r.sales_hint ?? null,
  };
}

/**
 * Motivos de ausência para debug DEV.
 * @param {object} [debug]
 * @param {Record<string, unknown> | null} raw
 */
export function buildEnrichAbsenceReasons(debug, raw) {
  const reasons = {};
  const attempts = Array.isArray(debug?.attempts) ? debug.attempts : [];
  const items403 = attempts.some((a) => String(a.endpoint || "").startsWith("/items/") && a.status === 403);
  const catalogTried = attempts.some((a) => String(a.endpoint || "").includes("/products/"));
  const catalogMatch = attempts.some((a) => a.fallback === "catalog_direct" || a.fallback === "catalog_match");

  if (!raw?.competitor_thumbnail) {
    if (items403) reasons.image = "items_api_403_third_party";
    else if (catalogTried && !catalogMatch) reasons.image = "catalog_scan_no_product_with_listing_id";
    else if (!catalogTried) reasons.image = "catalog_not_attempted";
    else reasons.image = "catalog_product_without_pictures";
  }
  if (raw?.competitor_price == null) {
    if (items403) reasons.price = "items_api_403_third_party";
    else if (catalogTried && !catalogMatch) reasons.price = "catalog_scan_no_listing_row";
    else reasons.price = "no_price_in_api_response";
  }
  if (!raw?.competitor_store_name) {
    if (!raw?.competitor_seller_id) reasons.seller = "seller_id_unavailable";
    else reasons.seller = "users_api_no_nickname";
  }
  return reasons;
}
