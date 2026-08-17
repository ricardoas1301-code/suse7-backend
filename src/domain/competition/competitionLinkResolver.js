// ============================================================
// S7 — Concorrência: resolve link ML → candidato normalizado (preview/cadastro).
//
// Fluxo com fallback:
//   1) parse URL → item_id ou catalog_product_id
//   2) GET /items/{id} (quando parece anúncio)
//   3) GET /products/{id}/items + buy_box_winner (catálogo ou /items falhou)
//   4) candidato mínimo só com listing_id (link produto.mercadolivre confiável)
//
// CRÍTICO: GET /items/{id} de terceiros costuma retornar 403 na API ML —
// não confundir com falta de permissão da conta do seller.
// ============================================================

import {
  fetchItem,
  fetchCatalogProduct,
  fetchCatalogProductItemsSafe,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { normalizeDiscoveredCompetitor } from "./competitionNormalizer.js";
import {
  mlItemBodyToCandidateRaw,
  mlCatalogItemRowToCandidateRaw,
  mlBuyBoxWinnerToCandidateRaw,
  pickCatalogProductThumbnail,
  isOwnCandidate,
} from "./strategies/mlCompetitorMapping.js";
import { parseMercadoLivreListingUrl, safeUrlHostForLog } from "./mlListingUrlParser.js";
import { titleFromMercadoLivrePermalink, buildMercadoLivreItemPermalink } from "./mlListingDisplay.js";

const SOURCE_STRATEGY = "ml_link";

function safeBodySummary(body) {
  if (!body || typeof body !== "object") return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  return {
    message: b.message != null ? String(b.message).slice(0, 120) : b.error != null ? String(b.error).slice(0, 120) : null,
    error: b.error != null ? String(b.error).slice(0, 80) : null,
  };
}

function pushAttempt(debug, entry) {
  if (!debug) return;
  if (!Array.isArray(debug.attempts)) debug.attempts = [];
  debug.attempts.push(entry);
}

/**
 * @param {string} accessToken
 * @param {string} itemId
 */
async function tryFetchItem(accessToken, itemId) {
  try {
    const item = await fetchItem(accessToken, itemId);
    return { ok: true, status: 200, item, body: null };
  } catch (e) {
    return {
      ok: false,
      status: e?.status ?? null,
      item: null,
      body: e?.body ?? null,
      message: String(e?.message ?? e).slice(0, 200),
    };
  }
}

/**
 * Resolve product_id de catálogo → candidato via /products/{id}/items e buy_box.
 * @param {string} accessToken
 * @param {string} productId
 * @param {object} [debug]
 */
async function tryResolveFromCatalogProduct(accessToken, productId, debug) {
  const meta = { name: null, thumbnail: null, id: productId };

  const itemsRes = await fetchCatalogProductItemsSafe(accessToken, productId, { limit: 20 });
  pushAttempt(debug, {
    endpoint: `/products/${productId}/items`,
    status: itemsRes.status,
    count: itemsRes.results.length,
    fallback: "catalog_items",
  });

  for (const row of itemsRes.results) {
    const raw = mlCatalogItemRowToCandidateRaw(row, meta);
    if (raw?.competitor_listing_id) return { raw, via: "catalog_items_row" };
  }

  let detail = null;
  let detailStatus = null;
  try {
    detail = await fetchCatalogProduct(accessToken, productId);
    detailStatus = 200;
  } catch (e) {
    detailStatus = e?.status ?? null;
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: detailStatus,
      fallback: "catalog_detail",
      body: safeBodySummary(e?.body),
    });
  }

  if (detail) {
    meta.name = detail?.name != null ? String(detail.name) : null;
    meta.thumbnail = pickCatalogProductThumbnail(detail);
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: detailStatus ?? 200,
      has_buy_box: Boolean(detail?.buy_box_winner),
      fallback: "catalog_detail",
    });

    const bbRaw = mlBuyBoxWinnerToCandidateRaw(detail, meta);
    if (bbRaw?.competitor_listing_id) return { raw: bbRaw, via: "buy_box_winner" };
  }

  return { raw: null, via: null, itemsStatus: itemsRes.status, detailStatus };
}

function buildMinimalCandidateFromLink(listingId, url) {
  const urlTrim = String(url || "").trim();
  const permalink = urlTrim.startsWith("http")
    ? urlTrim
    : buildMercadoLivreItemPermalink(listingId);
  const titleFromSlug = titleFromMercadoLivrePermalink(permalink);
  return {
    competitor_listing_id: listingId,
    competitor_title: titleFromSlug,
    competitor_store_name: null,
    competitor_seller_id: null,
    competitor_price: null,
    currency: "BRL",
    competitor_permalink: permalink,
    competitor_thumbnail: null,
    shipping: null,
    listing_type: null,
    reputation: null,
    sales_hint: null,
  };
}

function finalizeCandidate(raw, context, debug, meta = {}) {
  if (!raw?.competitor_listing_id) {
    return { ok: false, error: "Mercado Livre não retornou dados suficientes.", code: "insufficient_data" };
  }
  if (isOwnCandidate(context, raw)) {
    return {
      ok: false,
      error: "Este link é do seu próprio anúncio. Cadastre um concorrente diferente.",
      code: "own_listing",
    };
  }
  const candidate = normalizeDiscoveredCompetitor(raw, SOURCE_STRATEGY);
  if (debug) {
    debug.normalize_ok = true;
    debug.normalized_listing_id = candidate.competitor_listing_id;
    debug.partial = meta.partial === true;
    debug.resolved_via = meta.via ?? null;
  }
  console.info("[COMPETITION_LINK] normalizado", {
    listing_id: candidate.competitor_listing_id,
    via: meta.via ?? null,
    partial: meta.partial === true,
    has_title: Boolean(candidate.competitor_title),
    has_price: Boolean(candidate.competitor_price),
  });
  return {
    ok: true,
    candidate,
    item_id: candidate.competitor_listing_id,
    partial: meta.partial === true,
    resolved_via: meta.via ?? null,
  };
}

function mapFinalError(parsed, debug, lastItemStatus, catalogResult) {
  const idType = parsed.idType;
  const attempts = debug?.attempts ?? [];

  if (idType === "catalog_product") {
    const itemsSt = catalogResult?.itemsStatus;
    if (itemsSt === 404) {
      return {
        error: "Link de catálogo sem anúncios ativos no momento. Tente o link direto do anúncio (produto.mercadolivre.com.br).",
        code: "catalog_link_no_listings",
      };
    }
    return {
      error: "Não foi possível encontrar um anúncio neste link de catálogo. Cole o link direto do anúncio concorrente.",
      code: "catalog_link_unresolved",
    };
  }

  if (lastItemStatus === 404) {
    return {
      error: "Anúncio não encontrado no Mercado Livre. Verifique se o link está ativo.",
      code: "ml_item_not_found",
    };
  }

  // 403 em /items de terceiros é restrição da API — não culpar a conta do seller.
  if (lastItemStatus === 403) {
    const catalogTried = attempts.some((a) => String(a.endpoint || "").includes("/products/"));
    if (!catalogTried) {
      return {
        error: "Não foi possível ler os detalhes deste anúncio na API do Mercado Livre. Tente o link completo do anúncio ou cadastre pelo ID MLB.",
        code: "ml_item_access_restricted",
      };
    }
  }

  return {
    error: "Não foi possível identificar o anúncio neste link. Verifique a URL ou tente outro formato.",
    code: "link_unresolved",
  };
}

/**
 * @param {object} params
 * @param {string} params.accessToken
 * @param {string} params.url
 * @param {{ ownListingId?: string | null; ownSellerId?: string | null }} [params.context]
 * @param {object} [params.debug]
 */
export async function resolveCompetitorFromMercadoLivreLink({ accessToken, url, context = {}, debug = null }) {
  const urlHost = safeUrlHostForLog(url);
  console.info("[COMPETITION_LINK] url recebida", { url_host: urlHost });

  const parsed = parseMercadoLivreListingUrl(url);
  if (!parsed.ok) {
    console.info("[COMPETITION_LINK] parse failed", { code: parsed.code, url_host: urlHost });
    if (debug) {
      debug.parse_ok = false;
      debug.parse_code = parsed.code;
      debug.id = null;
      debug.id_type = null;
    }
    return { ok: false, error: parsed.error, code: parsed.code };
  }

  const mlId = parsed.id;
  console.info("[COMPETITION_LINK] id extraído", {
    id: mlId,
    id_type: parsed.idType,
    source: parsed.source,
    host_kind: parsed.hostKind,
  });

  if (debug) {
    debug.parse_ok = true;
    debug.id = mlId;
    debug.item_id = mlId;
    debug.id_type = parsed.idType;
    debug.parse_source = parsed.source;
    debug.host_kind = parsed.hostKind;
    debug.path_hint = parsed.pathHint;
    debug.attempts = [];
  }

  if (!accessToken) {
    return {
      ok: false,
      error: "Conecte uma conta do Mercado Livre em Integrações para buscar anúncios por link.",
      code: "ml_token_unavailable",
    };
  }

  const strategies =
    parsed.idType === "catalog_product"
      ? ["catalog", "item"]
      : parsed.idType === "item"
        ? ["item", "catalog"]
        : ["item", "catalog"];

  let lastItemStatus = null;
  let catalogResult = null;

  for (const strategy of strategies) {
    if (strategy === "item") {
      const itemRes = await tryFetchItem(accessToken, mlId);
      lastItemStatus = itemRes.status;
      pushAttempt(debug, {
        endpoint: `/items/${mlId}`,
        status: itemRes.status,
        body: safeBodySummary(itemRes.body),
      });
      console.info("[COMPETITION_LINK] try items", {
        id: mlId,
        status: itemRes.status,
        ok: itemRes.ok,
      });

      if (itemRes.ok && itemRes.item) {
        const raw = mlItemBodyToCandidateRaw(itemRes.item);
        const out = finalizeCandidate(raw, context, debug, { via: "items_api" });
        if (out.ok) return out;
      }
    }

    if (strategy === "catalog") {
      console.info("[COMPETITION_LINK] fallback catalog", { product_id: mlId });
      if (debug) debug.fallback_catalog = true;
      catalogResult = await tryResolveFromCatalogProduct(accessToken, mlId, debug);
      if (catalogResult.raw) {
        const out = finalizeCandidate(catalogResult.raw, context, debug, { via: catalogResult.via });
        if (out.ok) return out;
      }
    }
  }

  // Candidato mínimo só quando o ID do link é (provavelmente) item_id — nunca product_id de catálogo.
  const catalogFailed = !catalogResult?.raw;
  const allowMinimal =
    parsed.idType === "item" ||
    parsed.source === "raw_id" ||
    parsed.hostKind === "produto" ||
    parsed.hostKind === "articulo" ||
    (catalogFailed && (lastItemStatus === 403 || lastItemStatus === 404) && parsed.idType !== "catalog_product");

  if (allowMinimal && mlId) {
    console.info("[COMPETITION_LINK] candidato mínimo (listing_id do link)", { id: mlId });
    pushAttempt(debug, { fallback: "minimal_from_url", listing_id: mlId });
    const out = finalizeCandidate(buildMinimalCandidateFromLink(mlId, url), context, debug, {
      via: "minimal_from_url",
      partial: true,
    });
    if (out.ok) return out;
  }

  const mapped = mapFinalError(parsed, debug, lastItemStatus, catalogResult);
  if (debug) {
    debug.normalize_ok = false;
    debug.ml_status = lastItemStatus;
    debug.final_code = mapped.code;
  }
  console.info("[COMPETITION_LINK] resolve failed", {
    id: mlId,
    id_type: parsed.idType,
    code: mapped.code,
    last_item_status: lastItemStatus,
    attempts: debug?.attempts?.length ?? 0,
  });

  return { ok: false, error: mapped.error, code: mapped.code };
}
