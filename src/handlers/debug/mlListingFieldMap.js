// ======================================================
// GET /api/debug/marketplaces/mercado-livre/listings/field-map?ref=
// Diagnóstico de importação (1 anúncio): banco + APIs ML agregados.
// Temporário / evolutivo — base para inspectors multi-marketplace.
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { getValidMLToken } from "../ml/_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import {
  fetchItem,
  fetchItemDescription,
  fetchItemListingPerformance,
  fetchItemSalePrice,
  fetchItemVisitsTotal,
  fetchListingPricesRowForItem,
} from "../ml/_helpers/mercadoLibreItemsApi.js";
import { buildMlListingInspectorResponse } from "./_helpers/mlListingInspectorMercadoLivre.js";

const LOG_ERR = "[DEBUG ML FIELD MAP ERROR]";

/** Evita 500 quando res.json encontra referência circular (payloads ML). */
function jsonSafeForResponse(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return {
      _serialization_failed: true,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

function requestUrl(req) {
  const host = req.headers?.host || "localhost";
  const base = host.includes("localhost") ? "http://localhost" : `https://${host}`;
  return new URL(req.url || "/api", base);
}

function exposeErrorDetails() {
  return process.env.NODE_ENV !== "production" || process.env.DEBUG_S7 === "1";
}

/** MLB / texto: não pode ir em id.eq.* (UUID). */
function isListingUuidRef(ref) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref);
}

/** @param {unknown} err */
function supabaseErrPublic(err) {
  if (!err || typeof err !== "object") return { message: String(err) };
  const e = /** @type {Record<string, unknown>} */ (err);
  return {
    message: typeof e.message === "string" ? e.message : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    details: typeof e.details === "string" ? e.details : undefined,
    hint: typeof e.hint === "string" ? e.hint : undefined,
  };
}

export default async function handleMlListingFieldMap(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  console.log("[debug/ml-listing-field-map] handler enter GET");

  try {
    let auth;
    try {
      auth = await requireAuthUser(req);
    } catch (authErr) {
      console.error(LOG_ERR, "requireAuthUser threw", authErr);
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
        message: "Falha ao validar o token. Tente novamente ou faça login de novo.",
        ...(exposeErrorDetails()
          ? { detail: authErr instanceof Error ? authErr.message : String(authErr) }
          : {}),
      });
    }

    if (auth.error) {
      return res.status(auth.error.status).json({
        ok: false,
        error: "Unauthorized",
        message: auth.error.message,
      });
    }

    const { user, supabase } = auth;
    if (!user?.id) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
        message: "Token não informado ou inválido",
      });
    }
    if (!supabase) {
      console.error(LOG_ERR, "missing supabase client after auth");
      return res.status(500).json({
        ok: false,
        error: "Internal error",
        message: "Cliente de banco indisponível após autenticação.",
      });
    }

    let url;
    try {
      url = requestUrl(req);
    } catch (urlErr) {
      console.error(LOG_ERR, "requestUrl", urlErr);
      return res.status(400).json({
        ok: false,
        error: "URL inválida",
        message: "Não foi possível interpretar a URL da requisição.",
      });
    }

    const ref = (url.searchParams.get("ref") || "").trim();
    if (!ref) {
      return res.status(400).json({
        ok: false,
        error: "Informe o parâmetro ref (UUID da linha marketplace_listings ou external_listing_id MLB…).",
      });
    }

    const userId = user.id;
    const logPrefix = "[debug/ml-listing-field-map]";

    console.log(logPrefix, "checkpoint", "auth_ok", "userId=", userId);
    console.log(logPrefix, "checkpoint", "requestUrl_ok", "ref=", ref);

    const uuidRef = isListingUuidRef(ref);
    console.log(logPrefix, "checkpoint", "listing_query_start", { uuidRef });

    const listingSelect = [
      "id",
      "title",
      "marketplace",
      "price",
      "base_price",
      "original_price",
      "available_quantity",
      "sold_quantity",
      "status",
      "external_listing_id",
      "permalink",
      "health",
      "api_last_seen_at",
      "currency_id",
      "pictures_count",
      "variations_count",
      "seller_sku",
      "seller_custom_field",
      "listing_type_id",
      "raw_json",
      "product_id",
      "financial_analysis_blocked",
      "needs_attention",
      "attention_reason",
      "category_id",
      "updated_at",
      "products(catalog_completeness)",
    ].join(", ");

    let listingQuery = supabase
      .from("marketplace_listings")
      .select(listingSelect)
      .eq("user_id", userId)
      .eq("marketplace", ML_MARKETPLACE_SLUG);

    if (uuidRef) {
      listingQuery = listingQuery.or(`id.eq.${ref},external_listing_id.eq.${ref}`);
    } else {
      listingQuery = listingQuery.eq("external_listing_id", ref);
    }

    const { data: listing, error: lErr } = await listingQuery.maybeSingle();

    console.log(logPrefix, "checkpoint", "listing_query_end", { error: Boolean(lErr), hasRow: Boolean(listing) });

    if (lErr) {
      console.error(LOG_ERR, "listing_query", logPrefix, supabaseErrPublic(lErr));
      return res.status(500).json({
        ok: false,
        error: "Erro ao carregar anúncio.",
        message: "Falha na consulta ao banco (marketplace_listings).",
        stage: "listing_query",
        ...(exposeErrorDetails()
          ? { detail: supabaseErrPublic(lErr), hint_filter: "UUID usa id+external or; MLB só external_listing_id." }
          : {}),
      });
    }
    if (!listing) {
      return res.status(404).json({ ok: false, error: "Anúncio não encontrado para este usuário." });
    }

    const extId = String(listing.external_listing_id || "").trim();
    if (!extId) {
      return res.status(422).json({ ok: false, error: "Anúncio sem external_listing_id." });
    }

    console.log(logPrefix, "checkpoint", "health_query_start");

  const { data: health, error: hErr } = await supabase
    .from("marketplace_listing_health")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_listing_id", extId)
    .maybeSingle();

  if (hErr) {
    console.error(LOG_ERR, "health_query", logPrefix, supabaseErrPublic(hErr));
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar health.",
      message: "Falha na consulta marketplace_listing_health.",
      stage: "health_query",
      ...(exposeErrorDetails() ? { detail: supabaseErrPublic(hErr) } : {}),
    });
  }

    console.log(logPrefix, "checkpoint", "metrics_query_start");

  const { data: metrics, error: mErr } = await supabase
    .from("listing_sales_metrics")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", String(listing.marketplace || ML_MARKETPLACE_SLUG))
    .eq("external_listing_id", extId)
    .maybeSingle();

  if (mErr) {
    console.error(LOG_ERR, "metrics_query", logPrefix, supabaseErrPublic(mErr));
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar métricas.",
      message: "Falha na consulta listing_sales_metrics.",
      stage: "metrics_query",
      ...(exposeErrorDetails() ? { detail: supabaseErrPublic(mErr) } : {}),
    });
  }

    console.log(logPrefix, "checkpoint", "ml_api_block_start");

  let product = null;
  const pr = listing.products;
  if (Array.isArray(pr) && pr[0] && typeof pr[0] === "object") product = pr[0];
  else if (pr && typeof pr === "object" && !Array.isArray(pr)) product = pr;

  if (!product && listing.product_id) {
    const { data: prodRow } = await supabase
      .from("products")
      .select("id, catalog_completeness")
      .eq("id", listing.product_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (prodRow) product = prodRow;
  }

  /** @type {Record<string, string>} */
  const apiErrors = {};
  let item = null;
  let listingPricesRow = null;
  let salePrice = null;
  let description = null;
  /** @type {number | null} */
  let visitsApiTotal = null;
  let performanceApi = null;
  let tokenAvailable = false;

  try {
    const token = await getValidMLToken(userId);
    tokenAvailable = true;
    item = await fetchItem(token, extId);
    listingPricesRow = await fetchListingPricesRowForItem(token, item);
    salePrice = await fetchItemSalePrice(token, extId);
    try {
      description = await fetchItemDescription(token, extId);
    } catch (e) {
      apiErrors.description = e?.message || "description_failed";
    }
    try {
      const v = await fetchItemVisitsTotal(token, extId);
      visitsApiTotal = v.total;
    } catch (e) {
      apiErrors.visits = e?.message || "visits_failed";
    }
    try {
      performanceApi = await fetchItemListingPerformance(token, extId);
    } catch (e) {
      apiErrors.performance = e?.message || "performance_failed";
    }
  } catch (e) {
    tokenAvailable = false;
    apiErrors.ml_token_or_item = e?.message || String(e);
  }

  const ctx = {
    listing,
    health: health || null,
    metrics: metrics || null,
    product,
    item,
    listingPricesRow,
    salePrice,
    description,
    visitsApiTotal,
    performanceApi,
    tokenAvailable,
    apiErrors,
  };

    console.log(logPrefix, "checkpoint", "buildMlListingInspectorResponse_start");

  let payload;
  try {
    payload = buildMlListingInspectorResponse(ctx);
    console.log(logPrefix, "checkpoint", "buildMlListingInspectorResponse_end");
  } catch (buildErr) {
    console.error(logPrefix, "buildMlListingInspectorResponse", buildErr);
    return res.status(500).json({
      ok: false,
      error: "Internal error",
      message: "Falha ao montar o mapa de campos.",
      ...(exposeErrorDetails()
        ? { detail: buildErr instanceof Error ? buildErr.message : String(buildErr) }
        : {}),
    });
  }

  const raw = payload.raw_payloads && typeof payload.raw_payloads === "object" ? payload.raw_payloads : {};
  const safeRaw = {};
  for (const [k, v] of Object.entries(raw)) {
    safeRaw[k] = jsonSafeForResponse(v);
  }

  const body = { ok: true, ...payload, raw_payloads: safeRaw };
  try {
    console.log(logPrefix, "checkpoint", "response_json_start");
    const out = res.status(200).json(body);
    console.log(logPrefix, "checkpoint", "response_json_success");
    return out;
  } catch (jsonErr) {
    console.error(LOG_ERR, "res.json", jsonErr);
    return res.status(500).json({
      ok: false,
      error: "Internal error",
      message: "Falha ao serializar a resposta JSON.",
      ...(exposeErrorDetails()
        ? { detail: jsonErr instanceof Error ? jsonErr.message : String(jsonErr) }
        : {}),
    });
  }
  } catch (error) {
    console.error(LOG_ERR, error);
    const body = {
      ok: false,
      error: "Internal error",
      message: error instanceof Error ? error.message : String(error),
    };
    if (exposeErrorDetails() && error instanceof Error && error.stack) {
      body.stack = error.stack;
    }
    return res.status(500).json(body);
  }
}
