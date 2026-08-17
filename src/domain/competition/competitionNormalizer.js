// ============================================================
// S7 — Concorrência: normalizer + contrato único de concorrente
// Centraliza padronização de entrada (POST) e o formato de saída
// (response) consumido por competitionApi.js / ConcorrenciaPage.jsx /
// ConcorrenciaRaioxCompare.jsx e snapshots futuros.
//
// Regra-chave: o SKU localiza o PRODUTO interno do seller; ele não é
// a chave de busca do concorrente. A descoberta usa nome/palavras-chave/
// título/categoria/marca/GTIN/catálogo (ver mercado-livre-discovery.md).
//
// Valores monetários NUNCA usam float. Usamos decimal.js apenas para
// validar/normalizar a string que vai para numeric(14,2).
// ============================================================

import Decimal from "decimal.js";
import {
  pickPermalinkFromPayload,
  buildMercadoLivreItemPermalink,
  applyListingDisplayFallbacks,
} from "./mlListingDisplay.js";
import {
  computeEnrichStatus,
  mergeSalesHintPreserve,
  pickSalesHintFromRecord,
} from "./competitionEnrichHelpers.js";
import { annotateCompetitorListingStatus } from "./competitionListingStatus.js";
import { logSalesPipelineTrace } from "./competitionSalesPipelineTrace.js";

export const DEFAULT_MARKETPLACE = "mercado_livre";
export const DEFAULT_CURRENCY = "BRL";
export const DEFAULT_SOURCE_STRATEGY = "manual_placeholder";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID válido ou null (campos de FK opcionais não aceitam string solta). */
export function asUuidOrNull(value) {
  const s = value != null ? String(value).trim() : "";
  return UUID_RE.test(s) ? s : null;
}

/** Nome de loja/vendedor a partir dos aliases do payload/candidato. */
export function pickStoreNameFromInput(src) {
  const s = src && typeof src === "object" ? src : {};
  for (const key of [
    "competitor_store_name",
    "competitor_seller_name",
    "seller_nickname",
    "store_name",
    "seller_name",
  ]) {
    const v = cleanStr(s[key], 300);
    if (v) return v;
  }
  const seller = asPlainObject(s.seller);
  if (seller) {
    for (const key of ["nickname", "nick_name"]) {
      const v = cleanStr(seller[key], 300);
      if (v) return v;
    }
  }
  const bb = asPlainObject(s.buy_box_winner);
  if (bb?.seller_nickname != null) {
    const v = cleanStr(bb.seller_nickname, 300);
    if (v) return v;
  }
  return null;
}

/** Quantidade de vendas a partir dos aliases conhecidos. */
export function pickSalesHintFromInput(src) {
  const s = src && typeof src === "object" ? src : {};
  const fromRecord = pickSalesHintFromRecord(s);
  if (fromRecord != null) return fromRecord;
  const candidate = asPlainObject(s.candidate);
  if (candidate) {
    const fromCand = pickSalesHintFromRecord(candidate);
    if (fromCand != null) return fromCand;
  }
  return null;
}

/** Meta de enrich enviada no POST (busca/link/fila) — preservada no save. */
export function enrichExtrasFromSaveBody(src) {
  const s = src && typeof src === "object" ? src : {};
  return {
    sales_hint: pickSalesHintFromInput(s),
    shipping: normalizeShipping(s.shipping),
    listing_type: cleanStr(s.listing_type, 60),
    reputation: normalizeReputation(s.reputation),
    category_id: cleanStr(s.category_id, 40),
    category_path: cleanStr(s.category_path, 500),
    listing_updated_at: cleanStr(s.listing_updated_at, 40),
    payload_store_name: pickStoreNameFromInput(s),
  };
}

/** String limpa: trim, vazio → null, com limite opcional de tamanho. */
function cleanStr(value, max = 0) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "") return null;
  return max > 0 ? s.slice(0, max) : s;
}

function pickLatestIsoTimestamp(...candidates) {
  let bestIso = null;
  let bestMs = -1;
  for (const value of candidates) {
    if (!value) continue;
    const iso = String(value).trim();
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  }
  return bestIso;
}

/** Moeda → string decimal "129.90" (numeric-safe) ou null. Sem float em cálculo. */
export function normalizeMoneyString(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (s === "") return null;
  s = s.replace(/\s/g, "");
  // Aceita formato BR "1.234,56" / "129,90" e formato "129.90"
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  try {
    const d = new Decimal(s);
    if (!d.isFinite() || d.isNegative()) return null;
    return d.toFixed(2);
  } catch {
    return null;
  }
}

/**
 * Normaliza o payload de criação/reativação de concorrente.
 * Não decide ownership nem product_id — isso é responsabilidade do handler.
 */
export function normalizeCompetitionCompetitor(input) {
  const src = input && typeof input === "object" ? input : {};

  const marketplace = cleanStr(src.marketplace) || DEFAULT_MARKETPLACE;
  const currency = cleanStr(src.last_seen_currency) || DEFAULT_CURRENCY;
  const sourceStrategy = cleanStr(src.source_strategy) || DEFAULT_SOURCE_STRATEGY;

  const listingId = cleanStr(src.competitor_listing_id, 120);
  const permalinkRaw = pickPermalinkFromPayload(src);
  const permalink =
    cleanStr(permalinkRaw, 1000) || (listingId ? buildMercadoLivreItemPermalink(listingId) : null);
  const display = applyListingDisplayFallbacks({
    competitor_listing_id: listingId,
    competitor_title: cleanStr(src.competitor_title, 500),
    competitor_permalink: permalink,
  });

  return {
    marketplace,
    marketplace_account_id: asUuidOrNull(src.marketplace_account_id),
    seller_company_id: asUuidOrNull(src.seller_company_id),
    sku: cleanStr(src.sku, 120),
    competitor_listing_id: listingId,
    competitor_title: display.competitor_title,
    competitor_seller_id: cleanStr(src.competitor_seller_id, 120),
    competitor_store_name: pickStoreNameFromInput(src),
    competitor_permalink: display.competitor_permalink,
    competitor_thumbnail: cleanStr(src.competitor_thumbnail, 1000),
    source_strategy: sourceStrategy,
    last_seen_price: normalizeMoneyString(src.last_seen_price ?? src.competitor_price),
    last_seen_currency: cleanStr(src.last_seen_currency) || cleanStr(src.currency) || currency,
  };
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Shipping reduzido e estável (free_shipping/mode/logistic_type) para o candidato. */
function normalizeShipping(shipping) {
  const s = asPlainObject(shipping);
  if (!s) return {};
  return {
    free_shipping: s.free_shipping === true,
    mode: s.mode != null && String(s.mode).trim() !== "" ? String(s.mode).trim() : null,
    logistic_type:
      s.logistic_type != null && String(s.logistic_type).trim() !== "" ? String(s.logistic_type).trim() : null,
  };
}

/** Reputação pública reduzida (quando houver) — nunca dado privado. */
function normalizeReputation(reputation) {
  const r = asPlainObject(reputation);
  if (!r) return {};
  const transactionsRaw = r.transactions_completed ?? r.transactions_total ?? null;
  let transactionsCompleted = null;
  if (transactionsRaw != null) {
    const n = Number(transactionsRaw);
    if (Number.isFinite(n) && n > 0) transactionsCompleted = Math.trunc(n);
  }
  return {
    level_id: r.level_id != null && String(r.level_id).trim() !== "" ? String(r.level_id).trim() : null,
    power_seller_status:
      r.power_seller_status != null && String(r.power_seller_status).trim() !== ""
        ? String(r.power_seller_status).trim()
        : null,
    transactions_completed: transactionsCompleted,
  };
}

/** Lista estável de URLs de imagem do concorrente (máx. 24). */
export function normalizeCompetitorPictureUrls(value, fallbackThumb = null) {
  const urls = [];
  const seen = new Set();
  const push = (raw) => {
    const url = raw != null ? String(raw).trim() : "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url.slice(0, 1000));
  };
  push(fallbackThumb);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") push(entry);
      else if (entry && typeof entry === "object") push(entry.secure_url || entry.url);
    }
  }
  return urls.slice(0, 24);
}

/**
 * Contrato único de CANDIDATO de descoberta — catálogo e busca pública compartilham o mesmo shape.
 * Difere do concorrente salvo: usa `competitor_price`/`currency` + `shipping`/`listing_type`/`reputation`
 * (alinhado aos campos de snapshot). Nada é persistido nesta fase.
 */
export function normalizeDiscoveredCompetitor(raw, sourceStrategy) {
  const r = raw && typeof raw === "object" ? raw : {};
  const listingId = cleanStr(r.competitor_listing_id, 120);
  const permalinkRaw = pickPermalinkFromPayload(r) || cleanStr(r.competitor_permalink, 1000);
  const permalink =
    permalinkRaw || (listingId ? buildMercadoLivreItemPermalink(listingId) : null);
  const display = applyListingDisplayFallbacks({
    competitor_listing_id: listingId,
    competitor_title: cleanStr(r.competitor_title, 500),
    competitor_permalink: permalink,
  });
  return {
    competitor_listing_id: listingId,
    competitor_title: display.competitor_title,
    competitor_store_name: pickStoreNameFromInput(r) ?? cleanStr(r.competitor_store_name, 300),
    competitor_seller_id: cleanStr(r.competitor_seller_id, 120),
    competitor_price: normalizeMoneyString(r.competitor_price),
    currency: cleanStr(r.currency) || DEFAULT_CURRENCY,
    competitor_permalink: display.competitor_permalink,
    competitor_thumbnail: cleanStr(r.competitor_thumbnail, 1000),
    shipping: normalizeShipping(r.shipping),
    listing_type: cleanStr(r.listing_type, 60),
    reputation: normalizeReputation(r.reputation),
    category_id: cleanStr(r.category_id, 40),
    category_path: cleanStr(r.category_path, 500),
    listing_updated_at: cleanStr(r.listing_updated_at, 40),
    listing_status: cleanStr(r.status ?? r.listing_status, 40),
    sales_hint: pickSalesHintFromInput(r),
    source_strategy: cleanStr(sourceStrategy) || cleanStr(r.source_strategy) || DEFAULT_SOURCE_STRATEGY,
  };
}

/**
 * Contrato único de saída de concorrente (mesmo shape para list/create/reactivate).
 * Preço sempre como string "129.90" (ou null) para evitar ambiguidade de float no front.
 */
export function toCompetitorResponse(row, extras = {}) {
  const r = row || {};
  let lastSeenPrice = null;
  if (r.last_seen_price != null) {
    try {
      const d = new Decimal(r.last_seen_price);
      if (d.isFinite() && d.gt(0)) lastSeenPrice = d.toFixed(2);
    } catch {
      lastSeenPrice = null;
    }
  }
  const salesHint = mergeSalesHintPreserve(extras, r, extras.sales_hint);
  const shipping = normalizeShipping(extras.shipping);
  const listingType = cleanStr(extras.listing_type, 60);
  const reputation = normalizeReputation(extras.reputation);
  const competitorPictures = normalizeCompetitorPictureUrls(
    extras.competitor_pictures ?? r.competitor_pictures,
    r.competitor_thumbnail ?? extras.snapshot_thumbnail ?? null
  );
  const display = applyListingDisplayFallbacks(r);
  const snapThumb = extras.competitor_thumbnail ?? extras.snapshot_thumbnail ?? null;
  const snapStore = extras.competitor_store_name ?? extras.snapshot_store_name ?? null;
  const snapTitle = extras.competitor_title ?? extras.snapshot_title ?? null;
  let snapPrice = null;
  const snapPriceRaw = extras.competitor_price ?? extras.snapshot_price ?? null;
  if (snapPriceRaw != null) {
    try {
      const d = new Decimal(String(snapPriceRaw));
      if (d.isFinite() && d.gt(0)) snapPrice = d.toFixed(2);
    } catch {
      snapPrice = null;
    }
  }
  const mergedView = {
    ...r,
    competitor_title: display.competitor_title || snapTitle,
    competitor_store_name: r.competitor_store_name ?? snapStore,
    competitor_thumbnail: r.competitor_thumbnail ?? snapThumb,
    last_seen_price: lastSeenPrice ?? snapPrice,
  };
  const effectiveLastCapturedAt = pickLatestIsoTimestamp(
    r.last_captured_at ?? null,
    extras.snapshot_captured_at ?? null
  );
  const enrichMeta = computeEnrichStatus(mergedView, {
    snapshot_thumbnail: snapThumb,
    snapshot_store_name: snapStore,
    snapshot_price: snapPrice,
    snapshot_title: snapTitle,
    last_enrich_error: extras.last_enrich_error ?? null,
  });

  const response = {
    id: r.id ?? null,
    marketplace: r.marketplace ?? DEFAULT_MARKETPLACE,
    product_id: r.product_id ?? null,
    sku: r.sku ?? null,
    competitor_listing_id: r.competitor_listing_id ?? null,
    competitor_title: mergedView.competitor_title,
    competitor_seller_id: r.competitor_seller_id ?? null,
    competitor_store_name: mergedView.competitor_store_name,
    competitor_permalink: display.competitor_permalink,
    competitor_thumbnail: mergedView.competitor_thumbnail,
    competitor_pictures: competitorPictures,
    source_strategy: r.source_strategy ?? null,
    is_active: r.is_active === true,
    last_seen_price: mergedView.last_seen_price,
    last_seen_currency: r.last_seen_currency ?? DEFAULT_CURRENCY,
    last_captured_at: effectiveLastCapturedAt,
    snapshot_captured_at: cleanStr(extras.snapshot_captured_at, 40),
    price_captured_at: cleanStr(extras.snapshot_captured_at, 40),
    sales_hint: salesHint,
    sales_hint_source: cleanStr(extras.sales_hint_source, 80) || null,
    sales_hint_confidence: cleanStr(extras.sales_hint_confidence, 20) || null,
    shipping,
    listing_type: listingType,
    reputation,
    category_id: cleanStr(extras.category_id ?? r.category_id, 40),
    category_path: cleanStr(extras.category_path ?? r.category_path, 500),
    listing_updated_at: cleanStr(extras.listing_updated_at ?? r.listing_updated_at, 40),
    enrich_status: enrichMeta.enrich_status,
    enrich_missing_fields: enrichMeta.enrich_missing_fields,
    last_enrich_error: enrichMeta.last_enrich_error,
  };

  logSalesPipelineTrace("toCompetitorResponse", {
    competitor_id: response.id,
    item_id: response.competitor_listing_id,
    extras_sales_hint: extras.sales_hint ?? null,
    row_sales_hint: r.sales_hint ?? null,
    merged_sales_hint: salesHint,
    sales_hint_source: response.sales_hint_source,
    sales_hint_confidence: response.sales_hint_confidence,
  });

  const statusFields = annotateCompetitorListingStatus({
    rowStatus: r.competitor_listing_status,
    snapshotStatus: extras.listing_status ?? extras.snapshot_listing_status ?? null,
    last_seen_price: mergedView.last_seen_price ?? r.last_seen_price ?? null,
    competitor_thumbnail: mergedView.competitor_thumbnail ?? r.competitor_thumbnail ?? null,
    competitor_title: mergedView.competitor_title ?? r.competitor_title ?? null,
  });

  return {
    ...response,
    ...statusFields,
  };
}

/** Converte candidato enriquecido (raw ML) em patch para competition_competitors. */
export function competitorPatchFromEnrichedRaw(raw, sourceStrategy) {
  const n = normalizeDiscoveredCompetitor(raw, sourceStrategy || "ml_link");
  const patch = {
    competitor_title: n.competitor_title,
    competitor_seller_id: n.competitor_seller_id,
    competitor_store_name: n.competitor_store_name,
    competitor_permalink: n.competitor_permalink,
    competitor_thumbnail: n.competitor_thumbnail,
  };
  if (n.competitor_price != null) {
    patch.last_seen_price = n.competitor_price;
    patch.last_seen_currency = n.currency || DEFAULT_CURRENCY;
    patch.last_captured_at = new Date().toISOString();
  }
  return { patch, sales_hint: n.sales_hint };
}

/** Candidato discover/link → shape de persistência (competition_competitors). */
export function discoveredCandidateToSaveNormalized(candidate, sourceStrategy = "ml_link") {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  return normalizeCompetitionCompetitor({
    marketplace: DEFAULT_MARKETPLACE,
    competitor_listing_id: c.competitor_listing_id,
    competitor_title: c.competitor_title,
    competitor_seller_id: c.competitor_seller_id,
    competitor_store_name: pickStoreNameFromInput(c),
    competitor_permalink: c.competitor_permalink,
    competitor_thumbnail: c.competitor_thumbnail,
    source_strategy: c.source_strategy ?? sourceStrategy,
    last_seen_price: c.competitor_price,
    last_seen_currency: c.currency ?? DEFAULT_CURRENCY,
    sales_hint: pickSalesHintFromInput(c),
    shipping: c.shipping,
    listing_type: c.listing_type,
    reputation: c.reputation,
  });
}

/** Meta de snapshot (frete/tipo/reputação/vendas) a partir do candidato discover. */
export function enrichExtrasFromDiscoveredCandidate(candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  return {
    sales_hint: pickSalesHintFromInput(c),
    shipping: normalizeShipping(c.shipping),
    listing_type: cleanStr(c.listing_type, 60),
    reputation: normalizeReputation(c.reputation),
    category_id: cleanStr(c.category_id, 40),
    category_path: cleanStr(c.category_path, 500),
    listing_updated_at: cleanStr(c.listing_updated_at, 40),
  };
}
