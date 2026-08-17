// ============================================================
// S7 — Concorrência Inteligente: handler base (S1 Backend Base)
// Roteamento interno por método/path para /api/competition/*.
//
// Fase atual: CRUD de concorrentes + descoberta REAL Mercado Livre (/discover)
// + limite funcional de 6 ativos por produto (banco permite 9; regra de produto 6).
//
// Regra oficial: o SKU localiza o PRODUTO interno do seller; a busca
// de concorrente usa nome/palavras-chave/título/categoria/marca/GTIN/
// catálogo — nunca o SKU do seller como chave principal.
//
// Handler fino: validação + orquestração. Dados ficam no repository;
// contrato de saída no normalizer.
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { getValidMLToken } from "../ml/_helpers/mlToken.js";
import {
  normalizeCompetitionCompetitor,
  toCompetitorResponse,
  DEFAULT_MARKETPLACE,
  discoveredCandidateToSaveNormalized,
  enrichExtrasFromDiscoveredCandidate,
  enrichExtrasFromSaveBody,
} from "../../domain/competition/competitionNormalizer.js";
import {
  findOwnedProduct,
  listProductsWithCompetitorCounts,
  listActiveCompetitors,
  findCompetitorById,
  findCompetitorByListing,
  findCompetitorForProductDedup,
  findPrimaryListingForProduct,
  countActiveCompetitors,
  findLatestSnapshotMetaForCompetitors,
  insertCompetitor,
  updateCompetitor,
  deactivateCompetitor,
} from "../../domain/competition/competitionRepository.js";
import { CompetitionEngine } from "../../domain/competition/CompetitionEngine.js";
import { extractBrandGtinFromRawJson } from "../../domain/competition/strategies/mlCompetitorMapping.js";
import {
  captureCompetitorsSnapshot,
  insertEnrichSnapshotOnSave,
} from "../../domain/competition/competitionSnapshotService.js";
import { resolveCompetitionCandidateFromLink } from "../../domain/competition/competitionLinkCandidateResolver.js";
import { safeUrlHostForLog } from "../../domain/competition/mlListingUrlParser.js";
import { applyListingDisplayFallbacks, buildMercadoLivreItemPermalink } from "../../domain/competition/mlListingDisplay.js";
import {
  buildCompetitorSavePatch,
  computeEnrichStatus,
  isEnrichResultComplete,
  isFatalLinkResolveCode,
  logSaveBlockedIncomplete,
  logSaveNormalizedFields,
  logResponseSalesHint,
  logSalesAudit,
  preservePayloadFieldsAfterEnrich,
  pickSalesHintFromRecord,
} from "../../domain/competition/competitionEnrichHelpers.js";
import { fetchMercadoLivreSellerNickname } from "../../domain/competition/competitionListingEnricher.js";
import {
  enrichCompetitorForPersist,
  logGetMergedContract,
  logSaveContract,
} from "../../domain/competition/competitionEnrichPersist.js";
import {
  canonicalizeMercadoLivreListingId,
  completePartialCompetitorViaDiscovery,
} from "../../domain/competition/competitionLinkDiscoveryCompletion.js";
import { auditOwnVsCompetitorSales } from "../../domain/competition/competitionSalesMlAudit.js";
import { resolveSalesHintsForDiscoverCandidates } from "../../domain/competition/competitionSalesHintResolver.js";
import { resolveSellerMetaForDiscoverCandidates, resolveCategoryPathForDiscoverCandidates } from "../../domain/competition/competitionSellerMetaResolver.js";
import {
  inferSalesHintBottleneck,
  logSalesPipelineSummary,
  logSalesPipelineTrace,
  logSaveStageError,
} from "../../domain/competition/competitionSalesPipelineTrace.js";
import {
  countActiveCompetitorsByMonitoredListing,
  findListingForMonitoredListing,
  findMonitoredListingOwned,
} from "../../domain/competition/monitoredListingsRepository.js";
import { handleMonitoredListingsRoute } from "./monitoredListingsHandler.js";

/** Engine único reutilizado entre requisições (estratégias são stateless). */
const competitionEngine = new CompetitionEngine();

/**
 * Limite FUNCIONAL do Suse7 nesta fase: 6 concorrentes ativos por produto.
 * O banco permite até 9 (trigger), mas a regra de produto atual é 6 — validada aqui.
 */
const FUNCTIONAL_ACTIVE_LIMIT = 6;
const ACTIVE_LIMIT_MESSAGE = "Limite de 6 concorrentes ativos por produto atingido.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || "").trim());

/** Debug de descoberta só em DEV ou com flag explícita (nunca expõe token/payload sensível). */
function competitionDebugEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.S7_COMPETITION_DEBUG === "1";
}

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

/** Limite de 9 ativos vem do trigger (ERRCODE check_violation = '23514'). */
function isActiveLimitError(error) {
  if (!error) return false;
  const msg = String(error.message || "").toLowerCase();
  return String(error.code || "") === "23514" || msg.includes("limite de 9");
}

/** Colisão do unique parcial (concorrente ativo já existe). */
function isUniqueViolation(error) {
  return error && String(error.code || "") === "23505";
}

export default async function handleCompetition(req, res, rawPath) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(503).json({ ok: false, error: auth.error.message });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const path = String(rawPath || "").split("?")[0];
  const method = req.method;

  try {
    // GET /api/competition/products
    if (path === "/api/competition/products" && method === "GET") {
      return await getProducts(res, supabase, user.id);
    }

    // /api/competition/products/:productId/competitors  (GET | POST)
    const competitorsMatch = path.match(/^\/api\/competition\/products\/([^/]+)\/competitors$/);
    if (competitorsMatch) {
      const productId = decodeURIComponent(competitorsMatch[1]);
      if (method === "GET") return await getProductCompetitors(res, supabase, user.id, productId);
      if (method === "POST") return await postProductCompetitor(req, res, supabase, user.id, productId);
      return res.status(405).json({ ok: false, error: "Método não permitido" });
    }

    // POST /api/competition/products/:productId/discover  (descoberta real ML)
    const discoverMatch = path.match(/^\/api\/competition\/products\/([^/]+)\/discover$/);
    if (discoverMatch && method === "POST") {
      const productId = decodeURIComponent(discoverMatch[1]);
      return await postDiscover(req, res, supabase, user.id, productId);
    }

    // POST /api/competition/products/:productId/resolve-link  (link ML → preview candidato)
    const resolveLinkMatch = path.match(/^\/api\/competition\/products\/([^/]+)\/resolve-link$/);
    if (resolveLinkMatch && method === "POST") {
      const productId = decodeURIComponent(resolveLinkMatch[1]);
      return await postResolveLink(req, res, supabase, user.id, productId);
    }

    // POST /api/competition/products/:productId/snapshot  (captura manual de histórico)
    const snapshotMatch = path.match(/^\/api\/competition\/products\/([^/]+)\/snapshot$/);
    if (snapshotMatch && method === "POST") {
      const productId = decodeURIComponent(snapshotMatch[1]);
      return await postSnapshot(req, res, supabase, user.id, productId);
    }

    // DELETE /api/competition/competitors/:competitorId
    const deleteMatch = path.match(/^\/api\/competition\/competitors\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      const competitorId = decodeURIComponent(deleteMatch[1]);
      return await deleteCompetitor(res, supabase, user.id, competitorId);
    }

    const monitoredRoute = await handleMonitoredListingsRoute(req, res, path, method, supabase, user.id);
    if (monitoredRoute != null) return monitoredRoute;

    return res.status(404).json({ ok: false, error: "Rota de concorrência não encontrada", path });
  } catch (error) {
    console.error("[competition] unhandled", {
      user_id: user.id,
      path,
      method,
      message: error?.message,
      code: error?.code,
    });
    return res.status(500).json({ ok: false, error: "Erro interno no módulo de concorrência" });
  }
}

// ------------------------------------------------------------
// GET /api/competition/products
// ------------------------------------------------------------
async function getProducts(res, supabase, userId) {
  const products = await listProductsWithCompetitorCounts(supabase, userId);
  return res.status(200).json({ ok: true, products });
}

async function mapCompetitorsForResponse(supabase, userId, productId) {
  const rows = await listActiveCompetitors(supabase, userId, productId);
  let snapshotMeta = new Map();
  try {
    snapshotMeta = await findLatestSnapshotMetaForCompetitors(
      supabase,
      userId,
      rows.map((r) => r.id).filter(Boolean)
    );
  } catch (metaErr) {
    console.error("[competition] snapshot meta indisponível no GET competitors", {
      product_id: productId,
      message: metaErr?.message,
      code: metaErr?.code,
    });
  }
  return rows.map((r) => {
    const meta = snapshotMeta.get(r.id) ?? {};
    const response = toCompetitorResponse(r, {
      sales_hint: meta.sales_hint ?? null,
      shipping: meta.shipping ?? null,
      listing_type: meta.listing_type ?? null,
      reputation: meta.reputation ?? null,
      snapshot_thumbnail: meta.competitor_thumbnail ?? null,
      snapshot_store_name: meta.competitor_store_name ?? null,
      snapshot_price: meta.competitor_price ?? null,
      snapshot_title: meta.competitor_title ?? null,
      snapshot_captured_at: meta.captured_at ?? null,
      competitor_pictures: meta.competitor_pictures ?? null,
      listing_status: meta.listing_status ?? null,
    });
    if (competitionDebugEnabled()) {
      logGetMergedContract(response);
    }
    logSalesAudit("get_competitors", {
      layer: "get_merge",
      item_id: r.competitor_listing_id ?? null,
      competitor_id: r.id ?? null,
      snapshot_sales_hint: meta.sales_hint ?? null,
      response_sales_hint: response.sales_hint ?? null,
    });
    logSalesPipelineTrace("get_competitors_merge", {
      item_id: r.competitor_listing_id ?? null,
      competitor_id: r.id ?? null,
      snapshot_sales_hint: meta.sales_hint ?? null,
      response_sales_hint: response.sales_hint ?? null,
      sales_hint_source: response.sales_hint_source ?? null,
    });
    return response;
  });
}

// ------------------------------------------------------------
// GET /api/competition/products/:productId/competitors
// ------------------------------------------------------------
async function getProductCompetitors(res, supabase, userId, productId) {
  if (!isUuid(productId)) {
    return res.status(400).json({ ok: false, error: "productId inválido" });
  }
  const product = await findOwnedProduct(supabase, userId, productId);
  if (!product) {
    return res.status(404).json({ ok: false, error: "Produto não encontrado" });
  }

  const competitors = await mapCompetitorsForResponse(supabase, userId, productId);
  if (competitionDebugEnabled()) {
    for (const c of competitors) {
      console.info("[COMPETITION_LIST_RESPONSE]", {
        listing_id: c.competitor_listing_id,
        title: c.competitor_title ?? null,
        price: c.last_seen_price ?? null,
        thumbnail: c.competitor_thumbnail ? "yes" : null,
        store: c.competitor_store_name ?? null,
        sales_hint: c.sales_hint ?? null,
        free_shipping: c.shipping?.free_shipping === true ? true : null,
        listing_type: c.listing_type ?? null,
      });
    }
  }
  console.info("[COMPETITION_LIST] fields returned", {
    product_id: productId,
    count: competitors.length,
    without_permalink: competitors.filter((c) => !c.competitor_permalink).length,
    without_title: competitors.filter((c) => !c.competitor_title).length,
    without_price: competitors.filter((c) => !c.last_seen_price).length,
    without_thumbnail: competitors.filter((c) => !c.competitor_thumbnail).length,
  });
  return res.status(200).json({
    ok: true,
    product: { product_id: product.id, sku: product.sku ?? null, product_name: product.product_name ?? null },
    competitors,
    competitors_count: competitors.length,
  });
}

// ------------------------------------------------------------
// POST /api/competition/products/:productId/competitors
// Cria ou reativa concorrente monitorado.
// ------------------------------------------------------------
async function postProductCompetitor(req, res, supabase, userId, productId) {
  if (!isUuid(productId)) {
    return res.status(400).json({ ok: false, error: "productId inválido" });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  // Ownership do produto (service role bypassa RLS → validação explícita).
  const product = await findOwnedProduct(supabase, userId, productId);
  if (!product) {
    return res.status(404).json({ ok: false, error: "Produto não encontrado" });
  }

  const monitoredListingId =
    body?.monitored_listing_id != null && isUuid(body.monitored_listing_id)
      ? String(body.monitored_listing_id).trim()
      : null;
  let monitoredListing = null;
  if (monitoredListingId) {
    monitoredListing = await findMonitoredListingOwned(supabase, userId, monitoredListingId);
    if (!monitoredListing) {
      return res.status(404).json({ ok: false, error: "Anúncio monitorado não encontrado" });
    }
    if (monitoredListing.product_id && String(monitoredListing.product_id) !== String(productId)) {
      return res.status(400).json({ ok: false, error: "Anúncio monitorado não pertence a este produto" });
    }
  }

  const bodyExtrasFromPayload = enrichExtrasFromSaveBody(body);
  let normalized = normalizeCompetitionCompetitor(body);
  if (!normalized.competitor_listing_id) {
    return res.status(400).json({ ok: false, error: "competitor_listing_id é obrigatório" });
  }
  const canonicalListingId = canonicalizeMercadoLivreListingId(normalized.competitor_listing_id);
  if (canonicalListingId) {
    normalized = { ...normalized, competitor_listing_id: canonicalListingId };
  }

  const linkUrlFromBody = body?.link_url != null ? String(body.link_url).trim() : "";
  const isLinkSave =
    String(normalized.source_strategy || "").includes("ml_link") ||
    String(body?.source_strategy || "").includes("ml_link") ||
    Boolean(linkUrlFromBody);
  const normalizedSeedFromPayload = { ...normalized };
  console.info("[COMPETITION_LINK_SAVE_START]", {
    listing_id: normalized.competitor_listing_id,
    has_permalink: Boolean(normalized.competitor_permalink),
    source_strategy: normalized.source_strategy,
    is_link_save: isLinkSave,
    payload_keys: Object.keys(body || {}).filter((k) => !/token|secret/i.test(k)),
  });

  // SKU do concorrente herda o do produto interno quando não enviado (rótulo, não chave de busca).
  const skuFallback = normalized.sku || product.sku || null;

  // Multi-CNPJ/multi-conta: completa conta/empresa a partir do anúncio vinculado quando ausentes.
  let accountId = normalized.marketplace_account_id;
  let companyId = normalized.seller_company_id;
  let listingRow = null;
  try {
    if (monitoredListing) {
      listingRow = await findListingForMonitoredListing(supabase, userId, monitoredListing);
    } else {
      listingRow = await findPrimaryListingForProduct(supabase, userId, productId);
    }
    if (listingRow) {
      if (!accountId) accountId = listingRow.marketplace_account_id ?? null;
      if (!companyId) companyId = listingRow.seller_company_id ?? null;
    }
  } catch (e) {
    console.warn("[competition] listing enrich skipped", { product_id: productId, message: e?.message });
  }

  const rawJson =
    listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  const ownSellerId =
    rawJson?.seller_id != null && String(rawJson.seller_id).trim() !== ""
      ? String(rawJson.seller_id).trim()
      : null;

  let enrichExtrasForResponse = {
    sales_hint: bodyExtrasFromPayload.sales_hint ?? null,
    shipping: bodyExtrasFromPayload.shipping ?? {},
    listing_type: bodyExtrasFromPayload.listing_type ?? null,
    reputation: bodyExtrasFromPayload.reputation ?? {},
  };
  let enrichOk = false;
  let enrichError = null;
  let enrichResult = null;
  let storeNameSource = bodyExtrasFromPayload.payload_store_name ? "payload" : null;
  const saveStageCtx = {
    product_id: productId,
    item_id: normalized.competitor_listing_id,
    competitor_id: null,
    competitor_persisted: false,
    payload_sanitized: {
      listing_id: normalized.competitor_listing_id,
      source_strategy: normalized.source_strategy ?? null,
      has_title: Boolean(normalized.competitor_title),
      has_price: normalized.last_seen_price != null || normalized.competitor_price != null,
    },
  };

  try {
    const accessToken = await getValidMLToken(userId, {
      marketplaceAccountId: accountId ?? listingRow?.marketplace_account_id ?? null,
    });

    if (isLinkSave) {
      const linkUrl =
        (linkUrlFromBody !== "" ? linkUrlFromBody : null) ||
        normalized.competitor_permalink ||
        buildMercadoLivreItemPermalink(normalized.competitor_listing_id);

      const resolved = await resolveCompetitionCandidateFromLink({
        accessToken,
        url: linkUrl,
        productId,
        product,
        listingRow,
        marketplaceAccountId: accountId,
        userId,
        context: {
          ownListingId: listingRow?.external_listing_id ?? null,
          ownSellerId,
        },
      });

      if (!resolved.ok && isFatalLinkResolveCode(resolved.code)) {
        logSaveBlockedIncomplete({
          item_id: normalized.competitor_listing_id,
          missing_required_fields: resolved.missing_required_fields ?? [],
          reason: resolved.code ?? "resolve_failed",
        });
        return res.status(422).json({
          ok: false,
          code: resolved.code ?? "link_unresolved",
          error: resolved.error ?? "Não foi possível identificar o anúncio neste link.",
          missing_required_fields: resolved.missing_required_fields ?? null,
        });
      }

      if (resolved.ok && resolved.candidate) {
        normalized = discoveredCandidateToSaveNormalized(resolved.candidate);
        enrichExtrasForResponse = enrichExtrasFromDiscoveredCandidate(resolved.candidate);
      }
    }

    enrichResult = await enrichCompetitorForPersist(accessToken, normalized, {
      sourceStrategy: normalized.source_strategy || (isLinkSave ? "ml_link" : null),
      forceFullEnrich: isLinkSave,
      initialExtras: bodyExtrasFromPayload,
      catalog_product_id: listingRow?.catalog_product_id ?? null,
      marketplace_account_id: accountId ?? listingRow?.marketplace_account_id ?? null,
      connected_seller_id: ownSellerId,
      own_listing_id: listingRow?.external_listing_id ?? null,
    });
    normalized = enrichResult.normalized;
    enrichExtrasForResponse = {
      ...enrichExtrasForResponse,
      ...enrichResult.enrichExtras,
    };
    enrichOk = enrichResult.enrichOk;
    enrichError = enrichResult.enrichError;
    if (normalized.competitor_store_name && !storeNameSource) storeNameSource = "enrich";
    if (enrichError) {
      console.warn("[COMPETITION_LINK_SAVE] enrich failed", {
        listing_id: normalized.competitor_listing_id,
        message: enrichError,
      });
    }

    if (!isEnrichResultComplete(normalized, enrichExtrasForResponse) && accessToken && product?.id) {
      const completion = await completePartialCompetitorViaDiscovery({
        accessToken,
        userId,
        product,
        listingRow,
        ownSellerId,
        ownListingId: listingRow?.external_listing_id ?? null,
        normalized,
        enrichExtras: enrichExtrasForResponse,
        rawUrl: isLinkSave
          ? body?.link_url != null
            ? String(body.link_url).trim()
            : normalized.competitor_permalink
          : null,
      });
      if (completion.matched) {
        normalized = completion.normalized;
        enrichExtrasForResponse = completion.enrichExtras;
        enrichOk = computeEnrichStatus(normalized, enrichExtrasForResponse).enrich_status === "complete" || enrichOk;
        if (normalized.competitor_store_name && !storeNameSource) storeNameSource = "discovery";
      }
    }

    const preserved = preservePayloadFieldsAfterEnrich(normalized, enrichExtrasForResponse, bodyExtrasFromPayload);
    normalized = preserved.normalized;
    enrichExtrasForResponse = preserved.enrichExtras;
    if (preserved.storeSource) storeNameSource = preserved.storeSource;

    if (!normalized.competitor_store_name && normalized.competitor_seller_id && accessToken) {
      const nick = await fetchMercadoLivreSellerNickname(accessToken, normalized.competitor_seller_id);
      if (nick) {
        normalized = { ...normalized, competitor_store_name: nick };
        storeNameSource = "users_api";
      }
    }

    // Nunca degradar dados já obtidos no preview do modal (resolve-link).
    if (isLinkSave) {
      if (!normalized.competitor_title && normalizedSeedFromPayload.competitor_title) {
        normalized.competitor_title = normalizedSeedFromPayload.competitor_title;
      }
      if (!normalized.competitor_permalink && normalizedSeedFromPayload.competitor_permalink) {
        normalized.competitor_permalink = normalizedSeedFromPayload.competitor_permalink;
      }
      if (!normalized.competitor_thumbnail && normalizedSeedFromPayload.competitor_thumbnail) {
        normalized.competitor_thumbnail = normalizedSeedFromPayload.competitor_thumbnail;
      }
      if (!normalized.competitor_store_name && normalizedSeedFromPayload.competitor_store_name) {
        normalized.competitor_store_name = normalizedSeedFromPayload.competitor_store_name;
      }
      if (!normalized.competitor_seller_id && normalizedSeedFromPayload.competitor_seller_id) {
        normalized.competitor_seller_id = normalizedSeedFromPayload.competitor_seller_id;
      }
      if (!normalized.last_seen_price && normalizedSeedFromPayload.last_seen_price) {
        normalized.last_seen_price = normalizedSeedFromPayload.last_seen_price;
      }
      if (!normalized.last_seen_currency && normalizedSeedFromPayload.last_seen_currency) {
        normalized.last_seen_currency = normalizedSeedFromPayload.last_seen_currency;
      }
    }

    if (accessToken && listingRow?.external_listing_id && normalized.competitor_listing_id) {
      void auditOwnVsCompetitorSales(
        accessToken,
        String(listingRow.external_listing_id),
        String(normalized.competitor_listing_id)
      );
    }
  } catch (e) {
    enrichError = e?.message ?? String(e);
    logSaveStageError("enrich_candidate", saveStageCtx, e);
    console.warn("[COMPETITION_LINK_SAVE] enrich failed", {
      listing_id: normalized.competitor_listing_id,
      message: enrichError,
    });
    enrichExtrasForResponse = {
      ...enrichExtrasForResponse,
      sales_hint: null,
      sales_hint_source: null,
      sales_hint_confidence: null,
    };
  }

  if (!isLinkSave) {
    const displayFallback = applyListingDisplayFallbacks(normalized);
    normalized = {
      ...normalized,
      competitor_title: normalized.competitor_title || displayFallback.competitor_title,
      competitor_permalink: normalized.competitor_permalink || displayFallback.competitor_permalink,
    };
  }

  try {
    const existing = await findCompetitorForProductDedup(supabase, userId, {
      marketplace: normalized.marketplace,
      productId,
      competitorListingId: normalized.competitor_listing_id,
      competitorPermalink: normalized.competitor_permalink,
      monitoredListingId,
    });

    const alreadyRegistered = Boolean(existing?.is_active === true);

    // Limite funcional 6: só bloqueia quando a operação CRIA um novo ativo
    // (novo registro ou reativação de inativo). Atualizar ativo existente não conta.
    const willCreateActive = !existing || existing.is_active !== true;
    if (willCreateActive) {
      const activeCount = monitoredListingId
        ? await countActiveCompetitorsByMonitoredListing(supabase, userId, monitoredListingId)
        : await countActiveCompetitors(supabase, userId, productId);
      if (activeCount >= FUNCTIONAL_ACTIVE_LIMIT) {
        return res.status(409).json({ ok: false, error: ACTIVE_LIMIT_MESSAGE, code: "ACTIVE_LIMIT_REACHED" });
      }
    }

    const patch = buildCompetitorSavePatch({
      accountId,
      companyId,
      sku: skuFallback,
      sourceStrategy: normalized.source_strategy || (isLinkSave ? "ml_link" : null),
      normalized,
    });

    logSaveContract(normalized.competitor_listing_id, patch, enrichExtrasForResponse, enrichOk);

    const salesHintSource =
      enrichExtrasForResponse.sales_hint != null
        ? bodyExtrasFromPayload.sales_hint != null &&
          enrichExtrasForResponse.sales_hint === bodyExtrasFromPayload.sales_hint
          ? "payload"
          : "enrich_or_discovery"
        : null;

    logSaveNormalizedFields({
      item_id: normalized.competitor_listing_id,
      store_name_source: storeNameSource,
      sales_hint_source: salesHintSource,
      has_store_name: Boolean(normalized.competitor_store_name),
      sales_hint: enrichExtrasForResponse.sales_hint ?? null,
    });

    logSalesPipelineTrace("before_db_save", {
      item_id: normalized.competitor_listing_id,
      product_id: productId,
      sales_hint: enrichExtrasForResponse.sales_hint ?? null,
      sales_hint_source: enrichExtrasForResponse.sales_hint_source ?? null,
      sales_hint_confidence: enrichExtrasForResponse.sales_hint_confidence ?? null,
      enrich_ok: enrichOk,
    });

    let saved;
    let reactivated = false;
    try {
      if (existing) {
        reactivated = existing.is_active !== true;
        saved = await updateCompetitor(supabase, userId, existing.id, patch);
      } else {
        saved = await insertCompetitor(supabase, {
          user_id: userId,
          product_id: productId,
          monitored_listing_id: monitoredListingId,
          marketplace: normalized.marketplace,
          competitor_listing_id: normalized.competitor_listing_id,
          ...patch,
        });
      }
      saveStageCtx.competitor_id = saved?.id ?? null;
      saveStageCtx.competitor_persisted = true;
    } catch (saveErr) {
      logSaveStageError("save_competitor", saveStageCtx, saveErr);
      throw saveErr;
    }

    console.info("[COMPETITION_DB_AFTER_SAVE]", {
      listing_id: saved?.competitor_listing_id ?? normalized.competitor_listing_id,
      competitor_title: saved?.competitor_title ?? null,
      last_seen_price: saved?.last_seen_price != null ? String(saved.last_seen_price) : null,
      competitor_thumbnail: saved?.competitor_thumbnail ? "yes" : null,
      competitor_store_name: saved?.competitor_store_name ?? null,
      competitor_permalink: saved?.competitor_permalink ?? null,
    });

    let snapshotRow = null;
    try {
      snapshotRow = await insertEnrichSnapshotOnSave({
        supabase,
        userId,
        saved,
        enrichExtras: enrichExtrasForResponse,
        lastEnrichError: enrichError,
      });
      logSalesPipelineTrace("after_snapshot_insert", {
        item_id: saved?.competitor_listing_id ?? null,
        competitor_id: saved?.id ?? null,
        snapshot_inserted: Boolean(snapshotRow),
        snapshot_sales_hint: snapshotRow?.sales_hint ?? null,
        enrich_sales_hint: enrichExtrasForResponse.sales_hint ?? null,
      });
    } catch (snapErr) {
      logSaveStageError("insert_snapshot", saveStageCtx, snapErr);
      console.warn("[S7_COMPETITION_SAVE] snapshot on save skipped", {
        listing_id: saved?.competitor_listing_id ?? null,
        message: snapErr?.message ?? String(snapErr),
      });
      logSalesPipelineTrace("after_snapshot_insert_failed", {
        item_id: saved?.competitor_listing_id ?? null,
        competitor_id: saved?.id ?? null,
        error: snapErr?.message ?? String(snapErr),
        enrich_sales_hint: enrichExtrasForResponse.sales_hint ?? null,
      });
    }

    const enrichMeta = computeEnrichStatus(saved, {
      ...enrichExtrasForResponse,
      last_enrich_error: enrichError,
    });
    const savedMinimal = enrichMeta.enrich_status === "partial";

    console.info("[COMPETITION_LINK_SAVE] repository ok", {
      listing_id: saved?.competitor_listing_id ?? normalized.competitor_listing_id,
      is_active: saved?.is_active ?? null,
      saved_minimal: savedMinimal,
      enrich_status: enrichMeta.enrich_status,
      reactivated,
    });

    let competitorResponse;
    try {
      competitorResponse = toCompetitorResponse(saved, {
        ...enrichExtrasForResponse,
        last_enrich_error: enrichError,
      });
      logSalesPipelineTrace("build_response", {
        item_id: saved?.competitor_listing_id ?? null,
        competitor_id: saved?.id ?? null,
        response_sales_hint: competitorResponse?.sales_hint ?? null,
      });
    } catch (buildErr) {
      logSaveStageError("build_response", saveStageCtx, buildErr);
      competitorResponse = {
        id: saved?.id ?? null,
        marketplace: saved?.marketplace ?? normalized.marketplace,
        product_id: saved?.product_id ?? productId,
        sku: saved?.sku ?? null,
        competitor_listing_id: saved?.competitor_listing_id ?? normalized.competitor_listing_id,
        competitor_title: saved?.competitor_title ?? normalized.competitor_title ?? null,
        competitor_seller_id: saved?.competitor_seller_id ?? null,
        competitor_store_name: saved?.competitor_store_name ?? null,
        competitor_permalink: saved?.competitor_permalink ?? normalized.competitor_permalink ?? null,
        competitor_thumbnail: saved?.competitor_thumbnail ?? null,
        source_strategy: saved?.source_strategy ?? null,
        is_active: saved?.is_active === true,
        last_seen_price: saved?.last_seen_price != null ? String(saved.last_seen_price) : null,
        last_seen_currency: saved?.last_seen_currency ?? "BRL",
        last_captured_at: saved?.last_captured_at ?? null,
        sales_hint: enrichExtrasForResponse.sales_hint ?? null,
        sales_hint_source: enrichExtrasForResponse.sales_hint_source ?? null,
        sales_hint_confidence: enrichExtrasForResponse.sales_hint_confidence ?? null,
        shipping: enrichExtrasForResponse.shipping ?? {},
        listing_type: enrichExtrasForResponse.listing_type ?? null,
        reputation: enrichExtrasForResponse.reputation ?? {},
        enrich_status: "partial",
        enrich_missing_fields: [],
        last_enrich_error: enrichError,
      };
    }

    try {
      logSalesAudit("save_response", {
        layer: "post_save",
        item_id: saved?.competitor_listing_id ?? normalized.competitor_listing_id,
        competitor_id: saved?.id ?? null,
        payload_sales_hint: bodyExtrasFromPayload.sales_hint ?? null,
        enrich_sales_hint: enrichExtrasForResponse.sales_hint ?? null,
        response_sales_hint: competitorResponse.sales_hint ?? null,
      });

      logResponseSalesHint({
        competitor_id: saved?.id ?? null,
        item_id: saved?.competitor_listing_id ?? normalized.competitor_listing_id,
        sales_hint: competitorResponse.sales_hint ?? null,
        source: salesHintSource,
      });

      let dbReadSalesHint = null;
      if (saved?.id) {
        try {
          const verifyMeta = await findLatestSnapshotMetaForCompetitors(supabase, userId, [saved.id]);
          dbReadSalesHint = verifyMeta.get(saved.id)?.sales_hint ?? null;
          logSalesPipelineTrace("after_db_read_snapshot", {
            item_id: saved.competitor_listing_id,
            competitor_id: saved.id,
            db_read_sales_hint: dbReadSalesHint,
          });
        } catch (verifyErr) {
          logSaveStageError("read_snapshot", saveStageCtx, verifyErr);
        }
      }

      const directDiag = enrichResult?.directItemAudit?.diagnosis ?? null;
      const mlFinal = enrichResult?.directItemAudit?.hit != null;
      const verdict = inferSalesHintBottleneck({
        ml_resolved: mlFinal,
        ml_failure_class: directDiag?.failure_class_full ?? null,
        enrich_sales_hint: enrichExtrasForResponse.sales_hint,
        snapshot_sales_hint: snapshotRow?.sales_hint ?? dbReadSalesHint,
        api_response_sales_hint: competitorResponse.sales_hint,
      });

      const directAudit = enrichResult?.directItemAudit ?? null;
      logSalesPipelineSummary({
        item_id: saved?.competitor_listing_id ?? normalized.competitor_listing_id,
        competitor_id: saved?.id ?? null,
        resolved: directAudit?.resolved ?? mlFinal,
        scenario: directAudit?.scenario ?? directDiag?.scenario ?? null,
        ml_endpoint_called: Boolean(directAudit),
        ml_http_status: directDiag?.full_status ?? null,
        ml_sold_quantity_evidence: directDiag?.full_sold_quantity_evidence ?? null,
        ml_sold_quantity_raw: directDiag?.sold_quantity_full?.sold_quantity_raw ?? null,
        ml_has_sold_quantity_field: directDiag?.sold_quantity_full?.field_present ?? null,
        ml_resolved: mlFinal,
        ml_failure_class: directDiag?.failure_class_full ?? null,
        is_third_party: directDiag?.is_third_party_listing ?? null,
        audit_recommendation: directDiag?.recommendation ?? null,
        sales_hint: enrichExtrasForResponse.sales_hint ?? competitorResponse.sales_hint ?? null,
        sales_hint_source: enrichExtrasForResponse.sales_hint_source ?? null,
        enrich_sales_hint: enrichExtrasForResponse.sales_hint ?? null,
        enrich_sales_hint_source: enrichExtrasForResponse.sales_hint_source ?? null,
        snapshot_inserted: Boolean(snapshotRow),
        snapshot_sales_hint: snapshotRow?.sales_hint ?? dbReadSalesHint,
        db_read_sales_hint: dbReadSalesHint,
        api_response_sales_hint: competitorResponse.sales_hint ?? null,
        bottleneck: verdict.bottleneck,
        recommendation: verdict.recommendation,
      });
    } catch (diagErr) {
      logSaveStageError("return_response", saveStageCtx, diagErr);
    }

    return res.status(existing ? 200 : 201).json({
      ok: true,
      reactivated,
      already_registered: alreadyRegistered && !reactivated,
      saved_minimal: savedMinimal,
      enrich_ok: enrichOk,
      enrich_status: enrichMeta.enrich_status,
      enrich_missing_fields: enrichMeta.enrich_missing_fields,
      last_enrich_error: enrichMeta.last_enrich_error,
      competitor: competitorResponse,
    });
  } catch (error) {
    logSaveStageError("save_competitor_outer", saveStageCtx, error);
    console.error("[COMPETITION_LINK_SAVE] repository error", {
      listing_id: normalized.competitor_listing_id,
      code: error?.code ?? null,
      message: error?.message ?? String(error),
    });
    if (isActiveLimitError(error)) {
      return res.status(409).json({ ok: false, error: ACTIVE_LIMIT_MESSAGE, code: "ACTIVE_LIMIT_REACHED" });
    }
    if (isUniqueViolation(error)) {
      return res.status(409).json({
        ok: false,
        error: "Concorrente já está cadastrado e ativo neste produto.",
        code: "COMPETITOR_ALREADY_ACTIVE",
      });
    }
    throw error;
  }
}

// ------------------------------------------------------------
// DELETE /api/competition/competitors/:competitorId  (soft-delete)
// ------------------------------------------------------------
async function deleteCompetitor(res, supabase, userId, competitorId) {
  if (!isUuid(competitorId)) {
    return res.status(400).json({ ok: false, error: "competitorId inválido" });
  }

  const existing = await findCompetitorById(supabase, userId, competitorId);
  if (!existing) {
    return res.status(404).json({ ok: false, error: "Concorrente não encontrado" });
  }
  if (existing.is_active !== true) {
    // Já inativo: idempotente, devolve o registro sem novo write.
    return res.status(200).json({ ok: true, competitor: toCompetitorResponse(existing), already_inactive: true });
  }

  const saved = await deactivateCompetitor(supabase, userId, competitorId);
  return res.status(200).json({
    ok: true,
    competitor: toCompetitorResponse(saved),
    message: "Concorrente desativado (histórico preservado).",
  });
}

// ------------------------------------------------------------
// POST /api/competition/products/:productId/discover  (descoberta REAL)
// Fluxo: ownership → carregar produto + anúncio vinculado → resolver token ML
//        → CompetitionEngine (catálogo → fallback busca) → candidatos normalizados.
// Nunca persiste, nunca cria snapshot. Nunca erro de negócio: degrada para lista vazia.
// A query usa GTIN/título/categoria/marca/nome — nunca o SKU do seller como chave.
// ------------------------------------------------------------
async function postDiscover(req, res, supabase, userId, productId) {
  if (!isUuid(productId)) {
    return res.status(400).json({ ok: false, error: "productId inválido" });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  // 1) Ownership do produto.
  const product = await findOwnedProduct(supabase, userId, productId);
  if (!product) {
    return res.status(404).json({ ok: false, error: "Produto não encontrado" });
  }

  const marketplace =
    body?.marketplace != null && String(body.marketplace).trim() !== ""
      ? String(body.marketplace).trim()
      : DEFAULT_MARKETPLACE;
  const limit = Number.isFinite(Number(body?.limit)) ? Math.min(Math.max(Number(body.limit), 1), 50) : 24;
  const queryOverride = body?.query != null && String(body.query).trim() !== "" ? String(body.query).trim() : null;
  const catalogOffset = Number.isFinite(Number(body?.offset))
    ? Math.min(Math.max(Math.trunc(Number(body.offset)), 0), 80)
    : 0;
  const excludeListingIds = Array.isArray(body?.exclude_listing_ids)
    ? body.exclude_listing_ids.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const broadSearch = Boolean(queryOverride) || catalogOffset > 0;

  const monitoredListingId =
    body?.monitored_listing_id != null && isUuid(body.monitored_listing_id)
      ? String(body.monitored_listing_id).trim()
      : null;
  let monitoredListing = null;
  if (monitoredListingId) {
    monitoredListing = await findMonitoredListingOwned(supabase, userId, monitoredListingId);
    if (!monitoredListing) {
      return res.status(404).json({ ok: false, error: "Anúncio monitorado não encontrado" });
    }
    if (monitoredListing.product_id && String(monitoredListing.product_id) !== String(productId)) {
      return res.status(400).json({ ok: false, error: "Anúncio monitorado não pertence a este produto" });
    }
  }

  // 2) Anúncio do seller vinculado (catalog_product_id, category_id, título, atributos, conta).
  const listingRow = monitoredListing
    ? await findListingForMonitoredListing(supabase, userId, monitoredListing)
    : await findPrimaryListingForProduct(supabase, userId, productId);
  const rawJson = listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  const { brand, gtin } = extractBrandGtinFromRawJson(rawJson);
  const ownSellerId =
    rawJson?.seller_id != null && String(rawJson.seller_id).trim() !== "" ? String(rawJson.seller_id).trim() : null;

  console.info("[COMPETITION] Product loaded", {
    user_id: userId,
    product_id: productId,
    has_listing: Boolean(listingRow),
    catalog_listing: Boolean(listingRow?.catalog_listing),
    has_catalog_product_id: Boolean(listingRow?.catalog_product_id),
    has_category_id: Boolean(listingRow?.category_id),
    has_marketplace_account: Boolean(listingRow?.marketplace_account_id),
    has_gtin: Boolean(gtin),
    has_query_override: Boolean(queryOverride),
  });

  // 3) Token ML (multi-conta via marketplace_account vinculado ao anúncio).
  let accessToken = null;
  if (marketplace === DEFAULT_MARKETPLACE) {
    try {
      accessToken = await getValidMLToken(userId, {
        marketplaceAccountId: listingRow?.marketplace_account_id ?? null,
      });
    } catch (e) {
      // Sem token (conta não conectada) → degrada para lista vazia (nunca erro).
      console.warn("[COMPETITION] ML token unavailable", { user_id: userId, message: e?.message ?? String(e) });
      return res.status(200).json({
        ok: true,
        success: true,
        strategy: "none",
        total: 0,
        results: [],
        warning: "ml_token_unavailable",
      });
    }
  }

  if (!accessToken) {
    // Marketplace ainda sem estratégia/credencial nesta fase.
    return res.status(200).json({ ok: true, success: true, strategy: "none", total: 0, results: [] });
  }

  // 4) Contexto + execução do engine (catálogo → fallback busca pública).
  const debug = {
    strategy_attempted: [],
    search_queries_attempted: [],
    attempts: [],
    productsCount: 0,
    productIds: [],
    itemIdsCount: 0,
    normalizedCount: 0,
    discardReasons: [],
    discardedCount: 0,
    raw_results_count: 0,
    normalized_results_count: 0,
    has_token: true,
    warning: null,
    last_error: null,
    query: queryOverride,
    page: Math.floor(catalogOffset / 20),
    offset: catalogOffset,
    limit,
    mode: broadSearch ? "broad" : "auto",
    paging: null,
  };

  const context = {
    userId,
    marketplace,
    accessToken,
    limit,
    catalogOffset,
    excludeListingIds,
    broadSearch,
    searchOnly: broadSearch,
    query: queryOverride,
    product: { id: product.id, sku: product.sku ?? null, product_name: product.product_name ?? null },
    listing: {
      externalListingId: listingRow?.external_listing_id ?? null,
      catalogProductId: listingRow?.catalog_product_id ?? null,
      catalogListing: Boolean(listingRow?.catalog_listing),
      categoryId: listingRow?.category_id ?? null,
      title: listingRow?.title ?? null,
      brand,
      gtin,
    },
    ownListingId: listingRow?.external_listing_id ?? null,
    ownSellerId,
    debug,
  };

  console.info("[COMPETITION] Discover request", {
    user_id: userId,
    product_id: productId,
    query: queryOverride,
    offset: catalogOffset,
    limit,
    exclude_count: excludeListingIds.length,
    broad_search: broadSearch,
  });

  const { strategy, results } = await competitionEngine.discover(context);

  if (accessToken && results.length > 0) {
    await resolveSellerMetaForDiscoverCandidates(accessToken, results, { max: limit });
    await resolveCategoryPathForDiscoverCandidates(accessToken, results, { max: limit });
    await resolveSalesHintsForDiscoverCandidates(accessToken, results, {
      catalog_product_id: listingRow?.catalog_product_id ?? null,
      connected_seller_id: ownSellerId,
      own_listing_id: listingRow?.external_listing_id ?? null,
      max: limit,
    });
  }

  if (accessToken && listingRow?.external_listing_id && results.length > 0) {
    const firstCompId = results[0]?.competitor_listing_id;
    if (firstCompId) {
      void auditOwnVsCompetitorSales(
        accessToken,
        String(listingRow.external_listing_id),
        String(firstCompId)
      );
    }
  }

  const paging = debug.paging && typeof debug.paging === "object" ? debug.paging : {
    offset: catalogOffset,
    limit,
    page: Math.floor(catalogOffset / 20),
    hasMore: false,
    nextOffset: null,
  };

  // 5) Contrato único de descoberta (sem salvar). Debug seguro em DEV/flag — sem token.
  const payload = {
    ok: true,
    success: true,
    strategy,
    total: results.length,
    results,
    paging,
  };
  if (results.length === 0) {
    payload.warning = debug.warning || "no_candidates_found";
  }
  if (competitionDebugEnabled()) {
    payload.debug = {
      strategy_attempted: debug.strategy_attempted,
      search_queries_attempted: debug.search_queries_attempted,
      attempts: debug.attempts,
      productsCount: debug.productsCount,
      productIds: debug.productIds,
      itemIdsCount: debug.itemIdsCount,
      normalizedCount: debug.normalizedCount,
      discardReasons: debug.discardReasons,
      discardedCount: debug.discardedCount ?? 0,
      raw_results_count: debug.raw_results_count,
      normalized_results_count: debug.normalized_results_count,
      has_token: debug.has_token,
      warning: debug.warning || (results.length === 0 ? "no_candidates_found" : null),
      last_error: debug.last_error,
      query: queryOverride,
      page: debug.page,
      offset: catalogOffset,
      limit,
      mode: debug.mode,
      paging,
      relevance_sample: debug.relevance_sample ?? null,
    };
  }

  console.info("[COMPETITION] Discover response", {
    user_id: userId,
    product_id: productId,
    query: queryOverride,
    strategy,
    page: paging.page,
    offset: paging.offset,
    page_total: results.length,
    has_more: paging.hasMore,
    raw_rows: debug.raw_results_count,
    discarded: debug.discardedCount ?? 0,
  });

  for (const cand of (results || []).slice(0, 5)) {
    logSalesAudit("discover_response", {
      layer: "discover",
      item_id: cand?.competitor_listing_id ?? null,
      candidate_sales_hint: pickSalesHintFromRecord(cand),
      candidate_sold_quantity: cand?.sold_quantity ?? null,
      response_sales_hint: cand?.sales_hint ?? null,
    });
  }

  if (results.length === 0) {
    console.info("[COMPETITION] Discover empty", {
      user_id: userId,
      product_id: productId,
      query: queryOverride,
      offset: catalogOffset,
      strategy,
      strategy_attempted: debug.strategy_attempted,
      queries_attempted: debug.search_queries_attempted,
      products_count: debug.productsCount,
      product_ids: debug.productIds?.slice?.(0, 5),
      item_ids_count: debug.itemIdsCount,
      normalized_count: debug.normalizedCount,
      discard_sample: debug.discardReasons?.slice?.(0, 5),
      last_error: debug.last_error,
    });
  }
  return res.status(200).json(payload);
}

// ------------------------------------------------------------
// POST /api/competition/products/:productId/resolve-link
// Link de anúncio ML → candidato normalizado (preview antes do cadastro).
// ------------------------------------------------------------
async function postResolveLink(req, res, supabase, userId, productId) {
  if (!isUuid(productId)) {
    return res.status(400).json({ ok: false, error: "productId inválido" });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  const url = body?.url != null ? String(body.url).trim() : "";
  if (!url) {
    return res.status(400).json({ ok: false, error: "Informe o link do anúncio.", code: "url_empty" });
  }

  console.info("[S7_COMPETITION_LINK_RESOLVE_START]", {
    product_id: productId,
    url_host: safeUrlHostForLog(url),
  });

  const product = await findOwnedProduct(supabase, userId, productId);
  if (!product) {
    return res.status(404).json({ ok: false, error: "Produto não encontrado" });
  }

  const monitoredListingId =
    body?.monitored_listing_id != null && isUuid(body.monitored_listing_id)
      ? String(body.monitored_listing_id).trim()
      : null;
  let monitoredListing = null;
  if (monitoredListingId) {
    monitoredListing = await findMonitoredListingOwned(supabase, userId, monitoredListingId);
    if (!monitoredListing) {
      return res.status(404).json({ ok: false, error: "Anúncio monitorado não encontrado" });
    }
  }

  const listingRow = monitoredListing
    ? await findListingForMonitoredListing(supabase, userId, monitoredListing)
    : await findPrimaryListingForProduct(supabase, userId, productId);
  const rawJson = listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  const ownSellerId =
    rawJson?.seller_id != null && String(rawJson.seller_id).trim() !== "" ? String(rawJson.seller_id).trim() : null;

  let accessToken = null;
  try {
    accessToken = await getValidMLToken(userId, {
      marketplaceAccountId: listingRow?.marketplace_account_id ?? null,
    });
  } catch (e) {
    console.warn("[COMPETITION_LINK] ML token unavailable", { user_id: userId, message: e?.message ?? String(e) });
    return res.status(200).json({
      ok: false,
      error: "Conecte uma conta do Mercado Livre em Integrações para buscar anúncios por link.",
      code: "ml_token_unavailable",
    });
  }

  const debug = {
    url_host: safeUrlHostForLog(url),
    parse_ok: null,
    id: null,
    id_type: null,
    item_id: null,
    ml_status: null,
    normalize_ok: null,
    attempts: [],
    fallback_catalog: false,
    partial: false,
    resolved_via: null,
    final_code: null,
  };

  const resolved = await resolveCompetitionCandidateFromLink({
    accessToken,
    url,
    productId,
    product,
    listingRow,
    marketplaceAccountId: listingRow?.marketplace_account_id ?? null,
    userId,
    context: {
      ownListingId: listingRow?.external_listing_id ?? null,
      ownSellerId,
    },
    debug,
  });

  const candidate = resolved.candidate ?? null;
  const payload = {
    ok: resolved.ok,
    success: resolved.ok,
    candidate,
    item_id: resolved.item_id ?? debug.item_id ?? null,
    code: resolved.code ?? null,
    error: resolved.error ?? null,
    partial: resolved.partial === true,
    resolved_via: resolved.resolved_via ?? debug.resolved_via ?? null,
    missing_required_fields: resolved.missing_required_fields ?? resolved.enrich_missing_fields ?? null,
    enrich_status: resolved.enrich_status ?? (resolved.partial ? "partial" : resolved.ok ? "complete" : null),
    enrich_missing_fields: resolved.enrich_missing_fields ?? null,
  };

  if (competitionDebugEnabled()) {
    payload.debug = {
      ...debug,
      ...(resolved.linkDebug ?? {}),
    };
    if (!resolved.ok && resolved.linkDebug) {
      payload.debug = {
        parsed_item_id: resolved.linkDebug.parsed_item_id ?? null,
        parsed_catalog_product_id: resolved.linkDebug.parsed_catalog_product_id ?? null,
        slug_query: resolved.linkDebug.slug_query ?? null,
        attempted_steps: resolved.linkDebug.attempted_steps ?? [],
        missing_required_fields: resolved.missing_required_fields ?? resolved.linkDebug.missing_required_fields ?? [],
        item_fetch_status: resolved.linkDebug.item_fetch_status ?? null,
        seller_fetch_status: resolved.linkDebug.seller_fetch_status ?? null,
        discovery_fallback_total: resolved.linkDebug.discovery_fallback_total ?? null,
        discovery_fallback_matched: resolved.linkDebug.discovery_fallback_matched === true,
        discovery_match_reason: resolved.linkDebug.discovery_match_reason ?? null,
        discovery_queries_tried: resolved.linkDebug.discovery_queries_tried ?? [],
        discovery_sample_candidates: resolved.linkDebug.discovery_sample_candidates ?? [],
        legacy: debug,
      };
    }
  }

  console.info("[S7_COMPETITION_LINK_RESOLVE_RESULT]", {
    user_id: userId,
    product_id: productId,
    item_id: resolved.item_id ?? null,
    listing_id: candidate?.competitor_listing_id ?? null,
    ok: resolved.ok,
    code: resolved.code ?? null,
    partial: payload.partial,
    has_thumbnail: Boolean(candidate?.competitor_thumbnail),
    has_price: candidate?.competitor_price != null,
    has_store: Boolean(candidate?.competitor_store_name),
    has_shipping: Boolean(candidate?.shipping?.free_shipping === true || candidate?.shipping?.mode),
    listing_type: candidate?.listing_type ?? null,
    enrich_fields_found: debug.enrich_fields_found ?? null,
    enrich_fields_missing: debug.enrich_fields_missing ?? null,
  });

  logSalesAudit("resolve_link_response", {
    layer: "resolve_link",
    item_id: candidate?.competitor_listing_id ?? resolved.item_id ?? null,
    candidate_sales_hint: pickSalesHintFromRecord(candidate),
    candidate_sold_quantity: candidate?.sold_quantity ?? null,
    response_sales_hint: candidate?.sales_hint ?? null,
  });

  return res.status(200).json(payload);
}

// ------------------------------------------------------------
// POST /api/competition/products/:productId/snapshot
// Captura manual (on-demand) do histórico dos concorrentes ativos.
// Append-only em competition_snapshots + atualização dos campos atuais.
// ------------------------------------------------------------
async function postSnapshot(req, res, supabase, userId, productId) {
  if (!isUuid(productId)) {
    return res.status(400).json({ ok: false, error: "productId inválido" });
  }

  // 1) Ownership do produto.
  const product = await findOwnedProduct(supabase, userId, productId);
  if (!product) {
    return res.status(404).json({ ok: false, error: "Produto não encontrado" });
  }

  // 2) Concorrentes ativos — sem nenhum, retorna estado vazio (não é erro).
  const competitors = await listActiveCompetitors(supabase, userId, productId);
  if (competitors.length === 0) {
    return res.status(200).json({
      ok: true,
      success: true,
      product_id: productId,
      captured_count: 0,
      failed_count: 0,
      snapshots: [],
      empty: true,
    });
  }

  // 3) Token ML (multi-conta via anúncio vinculado; fallback p/ conta do concorrente).
  const listingRow = await findPrimaryListingForProduct(supabase, userId, productId);
  const accountId = listingRow?.marketplace_account_id ?? competitors[0]?.marketplace_account_id ?? null;
  let accessToken = null;
  try {
    accessToken = await getValidMLToken(userId, { marketplaceAccountId: accountId });
  } catch (e) {
    console.warn("[competition] snapshot ML token unavailable", { user_id: userId, message: e?.message ?? String(e) });
  }
  if (!accessToken) {
    return res.status(200).json({
      ok: true,
      success: true,
      product_id: productId,
      captured_count: 0,
      failed_count: competitors.length,
      snapshots: [],
      warning: "ml_token_unavailable",
    });
  }

  // 4) Captura + persistência (serviço dedicado).
  const rawJson =
    listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  const ownSellerId =
    rawJson?.seller_id != null && String(rawJson.seller_id).trim() !== ""
      ? String(rawJson.seller_id).trim()
      : null;

  const result = await captureCompetitorsSnapshot({
    supabase,
    accessToken,
    userId,
    product,
    competitors,
    listingRow,
    ownSellerId,
  });

  console.info("[COMPETITION] Snapshot captured", {
    user_id: userId,
    product_id: productId,
    captured_count: result.captured_count,
    failed_count: result.failed_count,
  });

  const competitorsOut = await mapCompetitorsForResponse(supabase, userId, productId);

  return res.status(200).json({
    ok: true,
    success: true,
    product_id: productId,
    captured_count: result.captured_count,
    failed_count: result.failed_count,
    snapshots: result.snapshots,
    competitors: competitorsOut,
    competitors_count: competitorsOut.length,
  });
}
