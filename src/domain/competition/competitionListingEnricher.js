// ============================================================
// S7 — Concorrência: enriquecimento oficial de anúncio ML por listing_id.
// Usado no cadastro por link, no save e no snapshot (Atualizar concorrentes).
// ============================================================

import {
  fetchItem,
  fetchItemsByIds,
  fetchCatalogProduct,
  searchCatalogProducts,
  fetchCatalogProductItemsSafe,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  mlItemBodyToCandidateRaw,
  mlCatalogItemRowToCandidateRaw,
  pickCatalogProductThumbnail,
  pickItemThumbnail,
  pickSellerTransactionsCompleted,
} from "./strategies/mlCompetitorMapping.js";
import {
  titleFromMercadoLivrePermalink,
  buildMercadoLivreItemPermalink,
  extractCatalogProductIdFromPermalink,
  resolveEnrichSourceLabel,
} from "./mlListingDisplay.js";
import {
  buildCatalogSearchQueries,
  summarizeEnrichRawForLog,
  buildEnrichAbsenceReasons,
} from "./competitionEnrichHelpers.js";
import { logSalesRawMl, logSalesUnavailable } from "./competitionSalesMlAudit.js";
import { resolveMlCompetitorEffectivePrice } from "./mlCompetitorEffectivePrice.js";

const ML_API = "https://api.mercadolibre.com";
const MAX_CATALOG_PRODUCTS_SCAN = 48;
const CATALOG_SEARCH_PAGE_SIZE = 12;

function safeBodySummary(body) {
  if (!body || typeof body !== "object") return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  return {
    message: b.message != null ? String(b.message).slice(0, 120) : null,
    error: b.error != null ? String(b.error).slice(0, 80) : null,
  };
}

function pushAttempt(debug, entry) {
  if (!debug) return;
  if (!Array.isArray(debug.attempts)) debug.attempts = [];
  debug.attempts.push(entry);
}

function hasShippingInfo(shipping) {
  if (!shipping || typeof shipping !== "object") return false;
  return shipping.free_shipping === true || shipping.mode != null || shipping.logistic_type != null;
}

function resolveImageSource(raw, via) {
  const v = String(via || "").toLowerCase();
  if (raw?.competitor_thumbnail) {
    if (v.includes("items_api") || v.includes("items_multiget")) return "item_thumbnail";
    if (v.includes("catalog")) return "catalog_product";
    return "item_picture";
  }
  return "none";
}

function resolvePriceSource(raw, via, explicitSource = null) {
  if (explicitSource) return explicitSource;
  if (raw?.competitor_price != null) {
    const v = String(via || "").toLowerCase();
    if (v.includes("catalog")) return "catalog_items_row";
    if (v.includes("items")) return "items_api";
    return "api";
  }
  return "none";
}

function resolveSellerSource(raw) {
  if (raw?.competitor_store_name) return "users_api";
  if (raw?.competitor_seller_id) return "catalog_items_row";
  return "none";
}

function needsCatalogEnrichment(raw) {
  if (!raw) return true;
  return (
    !raw.competitor_thumbnail ||
    raw.competitor_price == null ||
    !raw.competitor_seller_id ||
    !raw.competitor_store_name ||
    !hasShippingInfo(raw.shipping) ||
    !raw.listing_type
  );
}

export async function fetchMercadoLivreSellerPublicProfile(accessToken, sellerId) {
  const id = sellerId != null ? String(sellerId).trim() : "";
  if (!id || !accessToken) return null;
  try {
    const res = await fetch(`${ML_API}/users/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || typeof json !== "object") return null;
    const nick = json.nickname != null ? String(json.nickname).trim() : "";
    const rep = json.seller_reputation && typeof json.seller_reputation === "object" ? json.seller_reputation : null;
    return {
      nickname: nick || null,
      reputation: rep
        ? {
            level_id: rep.level_id ?? null,
            power_seller_status: rep.power_seller_status ?? null,
            transactions_completed: pickSellerTransactionsCompleted(rep),
          }
        : null,
    };
  } catch {
    return null;
  }
}

export async function fetchMercadoLivreSellerNickname(accessToken, sellerId) {
  const p = await fetchMercadoLivreSellerPublicProfile(accessToken, sellerId);
  return p?.nickname ?? null;
}

async function matchCatalogProductItemsRow(accessToken, productId, listingId, debug) {
  const itemsRes = await fetchCatalogProductItemsSafe(accessToken, productId, { limit: 50 });
  pushAttempt(debug, {
    endpoint: `/products/${productId}/items`,
    status: itemsRes.status,
    count: itemsRes.results.length,
    fallback: "catalog_direct",
  });
  const row = itemsRes.results.find(
    (r) => r?.item_id != null && String(r.item_id).trim() === String(listingId).trim()
  );
  if (!row) return null;
  logSalesRawMl({
    item_id: listingId,
    endpoint: `GET /products/${productId}/items`,
    status: itemsRes.status,
    body: row,
  });

  let productName = null;
  let thumbnail = null;
  try {
    const detail = await fetchCatalogProduct(accessToken, productId);
    productName = detail?.name != null ? String(detail.name) : null;
    thumbnail = pickCatalogProductThumbnail(detail);
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: 200,
      has_pictures: Boolean(thumbnail),
      fallback: "catalog_detail",
    });
  } catch (e) {
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: e?.status ?? null,
      body: safeBodySummary(e?.body),
    });
  }

  const meta = { name: productName, thumbnail };
  const raw = mlCatalogItemRowToCandidateRaw(row, meta);
  if (raw && !raw.competitor_thumbnail) {
    const rowThumb = pickItemThumbnail(row);
    if (rowThumb) raw.competitor_thumbnail = rowThumb;
  }
  return raw ? { raw, via: "catalog_product_items" } : null;
}

async function findCatalogRowForListingId(accessToken, listingId, permalink, debug, titleHint = null) {
  const queries = buildCatalogSearchQueries(permalink, titleHint, listingId);
  const seenProducts = new Set();
  let scannedProducts = 0;

  for (const q of queries) {
    for (let offset = 0; offset < 40 && scannedProducts < MAX_CATALOG_PRODUCTS_SCAN; offset += CATALOG_SEARCH_PAGE_SIZE) {
      let products = [];
      try {
        const r = await searchCatalogProducts(accessToken, {
          q,
          limit: CATALOG_SEARCH_PAGE_SIZE,
          offset,
          status: "active",
        });
        products = Array.isArray(r?.results) ? r.results : [];
        pushAttempt(debug, {
          endpoint: "/products/search",
          query: q.slice(0, 60),
          offset,
          status: 200,
          count: products.length,
        });
      } catch (e) {
        pushAttempt(debug, {
          endpoint: "/products/search",
          query: q.slice(0, 60),
          offset,
          status: e?.status ?? null,
          body: safeBodySummary(e?.body),
        });
        break;
      }
      if (products.length === 0) break;

      for (const p of products) {
        if (scannedProducts >= MAX_CATALOG_PRODUCTS_SCAN) break;
        const pid = p?.id != null ? String(p.id) : "";
        if (!pid || seenProducts.has(pid)) continue;
        seenProducts.add(pid);
        scannedProducts += 1;

        const hit = await matchCatalogProductItemsRow(accessToken, pid, listingId, debug);
        if (hit?.raw) {
          if (!hit.raw.competitor_thumbnail) {
            const searchThumb = pickCatalogProductThumbnail(p);
            if (searchThumb) hit.raw.competitor_thumbnail = searchThumb;
          }
          pushAttempt(debug, {
            fallback: "catalog_match",
            listing_id: listingId,
            product_id: pid,
            query: q.slice(0, 60),
            scanned_products: scannedProducts,
          });
          return { raw: hit.raw, via: "catalog_items_match" };
        }
      }
    }
  }

  pushAttempt(debug, {
    fallback: "catalog_scan_exhausted",
    listing_id: listingId,
    queries_tried: queries.length,
    scanned_products: scannedProducts,
  });
  return null;
}

export function mergeCompetitorRawFields(base, enriched) {
  const b = base && typeof base === "object" ? { ...base } : {};
  const e = enriched && typeof enriched === "object" ? enriched : {};
  const keys = [
    "competitor_listing_id",
    "competitor_title",
    "competitor_store_name",
    "competitor_seller_id",
    "competitor_price",
    "currency",
    "competitor_permalink",
    "competitor_thumbnail",
    "shipping",
    "listing_type",
    "reputation",
    "sales_hint",
  ];
  for (const k of keys) {
    const ev = e[k];
    const bv = b[k];
    if (ev != null && ev !== "" && (bv == null || bv === "")) b[k] = ev;
    else if (ev != null && ev !== "") b[k] = ev;
  }
  if (!b.competitor_listing_id && e.competitor_listing_id) b.competitor_listing_id = e.competitor_listing_id;
  return b;
}

export async function enrichCompetitorListing(accessToken, opts) {
  const listingId = opts?.listingId != null ? String(opts.listingId).trim() : "";
  const permalink = opts?.permalink != null ? String(opts.permalink).trim() : null;
  const fastDailyRefresh = opts?.fastDailyRefresh === true;
  const debug = opts?.debug && typeof opts.debug === "object" ? opts.debug : null;

  if (!listingId || !accessToken) {
    return { raw: null, via: null, enrichSource: "minimal", fieldsFound: [], fieldsMissing: ["listing_id", "token"] };
  }

  console.info("[COMPETITION_ENRICH_START]", { listing_id: listingId, has_permalink: Boolean(permalink) });
  if (debug) {
    debug.listing_id = listingId;
    debug.attempts = [];
  }

  let raw = null;
  let via = null;
  let itemBodyForPrice = null;

  try {
    const item = await fetchItem(accessToken, listingId);
    pushAttempt(debug, { endpoint: `/items/${listingId}`, status: 200 });
    logSalesRawMl({ item_id: listingId, endpoint: `GET /items/${listingId}`, status: 200, body: item });
    raw = mlItemBodyToCandidateRaw(item);
    via = "items_api";
    itemBodyForPrice = item;
  } catch (e) {
    logSalesRawMl({
      item_id: listingId,
      endpoint: `GET /items/${listingId}`,
      status: e?.status ?? null,
      body: e?.body ?? null,
      error: e?.message ?? null,
    });
    pushAttempt(debug, {
      endpoint: `/items/${listingId}`,
      status: e?.status ?? null,
      body: safeBodySummary(e?.body),
    });
  }

  if (!raw?.competitor_listing_id || needsCatalogEnrichment(raw)) {
    try {
      const map = await fetchItemsByIds(accessToken, [listingId]);
      const item = map.get(listingId);
      if (item) {
        pushAttempt(debug, { endpoint: `/items?ids=${listingId}`, status: 200 });
        logSalesRawMl({
          item_id: listingId,
          endpoint: `GET /items?ids=${listingId}`,
          status: 200,
          body: item,
        });
        raw = mlItemBodyToCandidateRaw(item);
        via = "items_multiget";
        itemBodyForPrice = item;
      } else {
        pushAttempt(debug, { endpoint: `/items?ids=${listingId}`, status: 200, note: "empty_body" });
      }
    } catch (e) {
      pushAttempt(debug, {
        endpoint: `/items?ids=${listingId}`,
        status: e?.status ?? null,
        body: safeBodySummary(e?.body),
      });
    }
  }

  if (!fastDailyRefresh && needsCatalogEnrichment(raw)) {
    const productIdFromUrl = extractCatalogProductIdFromPermalink(permalink);
    if (productIdFromUrl) {
      const directHit = await matchCatalogProductItemsRow(accessToken, productIdFromUrl, listingId, debug);
      if (directHit?.raw) {
        raw = mergeCompetitorRawFields(raw, directHit.raw);
        via = via ? `${via}+${directHit.via}` : directHit.via;
      }
    }
    if (needsCatalogEnrichment(raw)) {
      const catalogHit = await findCatalogRowForListingId(
        accessToken,
        listingId,
        permalink,
        debug,
        opts?.titleHint ?? raw?.competitor_title ?? null
      );
      if (catalogHit?.raw) {
        raw = mergeCompetitorRawFields(raw, catalogHit.raw);
        via = via ? `${via}+${catalogHit.via}` : catalogHit.via;
      }
    }
  }

  if (raw && !raw.competitor_permalink) {
    raw.competitor_permalink = permalink || buildMercadoLivreItemPermalink(listingId);
  }
  if (!raw?.competitor_listing_id) {
    raw = {
      competitor_listing_id: listingId,
      competitor_permalink: permalink || buildMercadoLivreItemPermalink(listingId),
    };
    via = via || "minimal";
  }

  if (raw && !raw.competitor_title) {
    const fromSlug = titleFromMercadoLivrePermalink(raw.competitor_permalink ?? permalink);
    if (fromSlug) {
      raw.competitor_title = fromSlug;
      via = via ? `${via}+url_slug` : "url_slug";
      pushAttempt(debug, { fallback: "url_slug", title_len: fromSlug.length });
    }
  }

  if (!fastDailyRefresh && raw?.competitor_seller_id) {
    const profile = await fetchMercadoLivreSellerPublicProfile(accessToken, raw.competitor_seller_id);
    pushAttempt(debug, {
      endpoint: `/users/${raw.competitor_seller_id}`,
      status: profile ? 200 : null,
      fallback: "seller_profile",
    });
    if (profile?.nickname && !raw.competitor_store_name) raw.competitor_store_name = profile.nickname;
    if (profile?.reputation && !raw.reputation) raw.reputation = profile.reputation;
  }

  const fallbackPriceSource =
    via && String(via).toLowerCase().includes("catalog")
      ? "discovery_fallback"
      : "items_fallback";
  const priceResolution = await resolveMlCompetitorEffectivePrice({
    itemId: listingId,
    accessToken,
    itemBody: itemBodyForPrice,
    fallbackPrice: raw?.competitor_price ?? null,
    fallbackCurrency: raw?.currency ?? "BRL",
    fallbackSource: fallbackPriceSource,
  });
  if (priceResolution?.effective_price != null) {
    raw = raw || {};
    raw.competitor_price = priceResolution.effective_price;
    raw.currency = priceResolution.currency_id || raw.currency || "BRL";
  }
  pushAttempt(debug, {
    endpoint: `/items/${listingId}/sale_price?context=channel_marketplace`,
    fallback: "effective_price_resolver",
    checked: priceResolution?.sale_price_checked === true,
    price_source: priceResolution?.price_source ?? null,
    has_effective_price: priceResolution?.effective_price != null,
    has_regular_price: priceResolution?.regular_price != null,
  });

  const imageSource = resolveImageSource(raw, via);
  const priceSource = resolvePriceSource(raw, via, priceResolution?.price_source ?? null);
  const sellerSource = resolveSellerSource(raw);
  const fieldsFound = [];
  const fieldsMissing = [];
  const check = [
    ["title", raw?.competitor_title],
    ["price", raw?.competitor_price],
    ["thumbnail", raw?.competitor_thumbnail],
    ["permalink", raw?.competitor_permalink],
    ["seller_id", raw?.competitor_seller_id],
    ["store_name", raw?.competitor_store_name],
    ["sales_hint", raw?.sales_hint],
    ["listing_type", raw?.listing_type],
    ["shipping", hasShippingInfo(raw?.shipping) ? raw.shipping : null],
    ["reputation", raw?.reputation],
  ];
  for (const [name, val] of check) {
    if (val != null && val !== "") fieldsFound.push(name);
    else fieldsMissing.push(name);
  }

  const enrichSource = resolveEnrichSourceLabel(via);
  const absenceReasons = buildEnrichAbsenceReasons(debug, raw);
  const enrichResult = summarizeEnrichRawForLog(raw);

  console.info("[COMPETITION_ENRICH_RESULT]", {
    listing_id: listingId,
    ...enrichResult,
    source_used: enrichSource,
    absence_reasons: absenceReasons,
  });
  console.info("[S7_COMPETITION_ENRICH_RESULT]", {
    listing_id: listingId,
    ...enrichResult,
    source_used: enrichSource,
    fields_found: fieldsFound,
    fields_missing: fieldsMissing,
  });
  console.info("[COMPETITION_ENRICH] image_source", { listing_id: listingId, image_source: imageSource });
  console.info("[COMPETITION_ENRICH] price_source", { listing_id: listingId, price_source: priceSource });
  console.info("[COMPETITION_ENRICH] seller_source", { listing_id: listingId, seller_source: sellerSource });

  if (debug) {
    debug.via = via;
    debug.source_used = enrichSource;
    debug.image_source = imageSource;
    debug.price_source = priceSource;
    debug.seller_source = sellerSource;
    debug.fields_found = fieldsFound;
    debug.fields_missing = fieldsMissing;
    debug.absence_reasons = absenceReasons;
  }

  if (!raw?.sales_hint || Number(raw.sales_hint) <= 0) {
    const endpoints_checked = (debug?.attempts || [])
      .map((a) => (a?.endpoint ? String(a.endpoint) : null))
      .filter(Boolean);
    logSalesUnavailable({
      item_id: listingId,
      reason: "enrich_completed_without_sales_hint",
      endpoints_checked,
    });
  }

  return {
    raw,
    via,
    enrichSource,
    imageSource,
    priceSource,
    sellerSource,
    fieldsFound,
    fieldsMissing,
    absenceReasons,
    enrichResult,
  };
}
