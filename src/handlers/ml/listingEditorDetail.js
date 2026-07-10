import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { resolveListingEditorAdapter } from "./_helpers/listingEditor/listingEditorAdapters.js";
import { resolverUrlEdicaoMarketplaceMl } from "./_helpers/listingEditor/mercadoLivreListingEditorAdapter.js";
import { carregarContextoProdutoListingEditor } from "./_helpers/listingEditor/listingEditorProductContext.js";
import { carregarListingVirtualStockSettings } from "./_helpers/listingEditor/listingVirtualStockSettingsStore.js";
import { carregarListingPrimaryPictureSettings } from "./_helpers/listingEditor/listingPrimaryPictureSettingsStore.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { buildListingImagesSummary } from "../../domain/listings/images/buildListingImagesSummary.js";
import { resolveListingImagesPolicy } from "../../domain/listings/images/resolveListingImagesPolicy.js";
import { buildListingDescriptionSummary } from "../../domain/listings/description/buildListingDescriptionSummary.js";
import { carregarListingLocalDescriptionSettings } from "./_helpers/listingEditor/listingLocalDescriptionSettingsStore.js";
import { buildListingMeasurementsSummary } from "../../domain/listings/measurements/buildListingMeasurementsSummary.js";
import { resolveListingMarketplaceMeasurements } from "../../domain/listings/measurements/resolveListingMarketplaceMeasurements.js";
import { carregarListingLocalMeasurementSettings } from "./_helpers/listingEditor/listingLocalMeasurementSettingsStore.js";
import {
  fetchItem,
  fetchItemDescription,
  fetchMercadoLivreItemFullDetail,
  fetchMercadoLivreItemPricesShowAll,
  fetchItemVisitsTotal,
  fetchItemListingPerformance,
  fetchItemPurchaseExperienceIntegrators,
} from "./_helpers/mercadoLibreItemsApi.js";
import {
  isPostgrestMissingColumnError,
  listingsHealthSelectForTier,
} from "./_helpers/mlHealthSchemaCompat.js";

/**
 * @param {unknown} value
 */
function textoOuVazio(value) {
  return value != null ? String(value).trim() : "";
}

/**
 * @param {string | null | undefined} apiLastSeenAt
 */
function isListingSnapshotStale(apiLastSeenAt) {
  const text = textoOuVazio(apiLastSeenAt);
  if (!text) return true;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > 20 * 60 * 1000;
}

/**
 * @param {Record<string, unknown>} rawItem
 */
function hasMinimumDetailFields(rawItem) {
  const hasAttrs = Array.isArray(rawItem.attributes) && rawItem.attributes.length > 0;
  const hasCategory = textoOuVazio(rawItem.category_id) !== "";
  const hasStatus = textoOuVazio(rawItem.status) !== "";
  return hasAttrs && hasCategory && hasStatus;
}

async function loadListingHealthRowCompat(supabase, userId, marketplace, externalListingId) {
  for (let tier = 0; tier <= 3; tier++) {
    const { data, error } = await supabase
      .from("marketplace_listing_health")
      .select(listingsHealthSelectForTier(/** @type {0 | 1 | 2 | 3} */ (tier)))
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("external_listing_id", externalListingId)
      .maybeSingle();
    if (!error) return data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : null;
    if (!isPostgrestMissingColumnError(error)) return null;
  }
  return null;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [meta]
 */
function logListingDetail(event, meta = {}) {
  if (process.env.NODE_ENV === "production") return;
  console.info(`[S7_LISTING_DETAIL] ${event}`, meta);
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label}_timeout`);
      // @ts-ignore - extra flag for controle de fallback
      err.code = "timeout";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

/**
 * @param {unknown} value
 */
function numeroOuNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extrairTextoMlResumo(value) {
  if (value == null) return null;
  if (typeof value === "string") return textoOuVazio(value) || null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const text = /** @type {Record<string, unknown>} */ (value).text;
    return text != null ? textoOuVazio(text) || null : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function urlHttpsSegura(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

/**
 * @param {string | null | undefined} raw
 */
function formatarStatusLabel(raw) {
  const text = textoOuVazio(raw);
  if (!text) return "—";
  const s = text.toLowerCase();
  if (s === "active" || s === "ativo") return "Ativo";
  if (s === "paused" || s === "pausado") return "Pausado";
  if (s === "closed" || s === "finalizado") return "Finalizado";
  if (s === "under_review" || s === "em revisão" || s === "em revisao") return "Em revisão";
  if (s === "inactive" || s === "not_yet_active" || s === "inativo") return "Inativo";
  const humanized = text.replace(/_/g, " ");
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * @param {Record<string, unknown> | null | undefined} listingRow
 * @param {Record<string, unknown> | null | undefined} rawItem
 */
function buildSafeSummary(listingRow, rawItem) {
  const statusRaw = textoOuVazio(rawItem?.status ?? listingRow?.status);
  return {
    status_label: formatarStatusLabel(statusRaw),
    visits: null,
    visits_available: false,
    conversion_percent: null,
    sold_quantity: numeroOuNull(rawItem?.sold_quantity),
    sku_label: textoOuVazio(rawItem?.seller_custom_field ?? listingRow?.seller_sku) || null,
    stock_label:
      rawItem?.available_quantity != null && String(rawItem.available_quantity).trim() !== ""
        ? String(rawItem.available_quantity)
        : null,
    category_name: textoOuVazio(rawItem?.category_name) || null,
    category_id: textoOuVazio(rawItem?.category_id) || null,
    brand: null,
    universal_code: null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} payload
 * @param {Record<string, unknown>} listingRow
 * @param {Record<string, unknown>} rawItem
 */
function buildSafeDetailPayload(payload, listingRow, rawItem) {
  const safeSummaryBase = buildSafeSummary(listingRow, rawItem);
  const basePayload = payload && typeof payload === "object" ? payload : {};
  const summaryCandidate =
    basePayload.summary && typeof basePayload.summary === "object" ? basePayload.summary : {};
  const qualityCandidate =
    basePayload.quality && typeof basePayload.quality === "object" ? basePayload.quality : {};
  const purchaseExperienceCandidate =
    basePayload.purchase_experience && typeof basePayload.purchase_experience === "object"
      ? basePayload.purchase_experience
      : {};

  return {
    ...basePayload,
    marketplace_edit_url:
      urlHttpsSegura(basePayload.marketplace_edit_url) ??
      urlHttpsSegura(basePayload.external_edit_url) ??
      resolverUrlEdicaoMarketplaceMl(rawItem, listingRow),
    external_edit_url:
      urlHttpsSegura(basePayload.external_edit_url) ??
      urlHttpsSegura(basePayload.marketplace_edit_url) ??
      resolverUrlEdicaoMarketplaceMl(rawItem, listingRow),
    summary: {
      ...safeSummaryBase,
      ...summaryCandidate,
      status_label: textoOuVazio(summaryCandidate.status_label ?? safeSummaryBase.status_label) || "—",
    },
    quality: {
      display_value: "—",
      score_percent: null,
      level_label: "Sem calcular",
      objectives_label: "Ainda não há dados suficientes",
      tone: "neutral",
      source: "unavailable",
      ...qualityCandidate,
    },
    purchase_experience: {
      display_value: "—",
      score_percent: null,
      label: "Ainda não podemos calculá-la",
      description: null,
      tone: "neutral",
      source: "unavailable",
      ...purchaseExperienceCandidate,
    },
  };
}

export default async function handleListingEditorDetail(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const listingId = textoOuVazio(req.query?.listing_id ?? req.query?.listingId);
  if (!listingId) {
    return res.status(400).json({ ok: false, error: "Informe listing_id." });
  }
  logListingDetail("start", { listing_id: listingId, method: req.method });

  const { user, supabase } = auth;
  const warnings = [];

  const { data: listingRow, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select(
      "id, user_id, marketplace, marketplace_account_id, external_listing_id, title, status, listing_type_id, seller_sku, product_id, available_quantity, raw_json, api_last_seen_at",
    )
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (listingErr || !listingRow) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }
  logListingDetail("ownership_ok", { listing_id: listingId, user_id: user.id });

  const adapter = resolveListingEditorAdapter(listingRow.marketplace);
  if (!adapter) {
    return res.status(422).json({
      ok: false,
      error: "Marketplace ainda não suportado para edição básica neste MVP.",
    });
  }

  const { data: descRowRaw } = await supabase
    .from("marketplace_listing_descriptions")
    .select("plain_text, html_text")
    .eq("listing_id", listingId)
    .maybeSingle();
  const descriptionRow =
    descRowRaw && typeof descRowRaw === "object" ? /** @type {Record<string, unknown>} */ (descRowRaw) : {};

  const { data: pictureRows } = await supabase
    .from("marketplace_listing_pictures")
    .select("secure_url, url, position, raw_json")
    .eq("listing_id", listingId)
    .order("position", { ascending: true });

  /** @type {Record<string, unknown>} */
  const rawItemLocal =
    listingRow.raw_json && typeof listingRow.raw_json === "object" && !Array.isArray(listingRow.raw_json)
      ? /** @type {Record<string, unknown>} */ (listingRow.raw_json)
      : {};
  logListingDetail("local_snapshot_loaded", {
    listing_id: listingId,
    has_raw_json: Object.keys(rawItemLocal).length > 0,
    has_description: Boolean(descriptionRow?.plain_text || descriptionRow?.html_text),
  });

  let rawItem = rawItemLocal;
  const externalListingId = textoOuVazio(listingRow.external_listing_id);
  const marketplaceAccountId = textoOuVazio(listingRow.marketplace_account_id) || null;

  /** @type {string | null} */
  let mlToken = null;
  if (externalListingId) {
    try {
      mlToken = await getValidMLToken(user.id, { marketplaceAccountId });
    } catch (err) {
      warnings.push("ml_token_unavailable");
      logListingDetail("ml_token_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const forceLiveSync =
    textoOuVazio(req.query?.live_sync).toLowerCase() === "1" ||
    textoOuVazio(req.query?.live_sync).toLowerCase() === "true";
  const shouldTryLiveSync =
    externalListingId &&
    (forceLiveSync || isListingSnapshotStale(listingRow.api_last_seen_at) || !hasMinimumDetailFields(rawItemLocal));

  if (shouldTryLiveSync) {
    logListingDetail("ml_sync_start", {
      listing_id: listingId,
      external_listing_id: externalListingId,
      force_live_sync: forceLiveSync,
    });
    try {
      if (!mlToken) {
        mlToken = await getValidMLToken(user.id, { marketplaceAccountId });
      }
      const liveItem = await withTimeout(fetchItem(mlToken, externalListingId), 10000, "ml_fetch_item");
      if (liveItem && typeof liveItem === "object" && !Array.isArray(liveItem)) {
        rawItem = /** @type {Record<string, unknown>} */ (liveItem);
        await supabase
          .from("marketplace_listings")
          .update({
            raw_json: rawItem,
            title: textoOuVazio(rawItem.title) || listingRow.title,
            status: textoOuVazio(rawItem.status) || listingRow.status,
            api_last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", listingId)
          .eq("user_id", user.id);
      }
      logListingDetail("ml_sync_success", {
        listing_id: listingId,
        external_listing_id: externalListingId,
      });
      if (!descriptionRow?.plain_text && !descriptionRow?.html_text) {
        try {
          const liveDescription = await withTimeout(
            fetchItemDescription(mlToken, externalListingId),
            10000,
            "ml_fetch_description",
          );
          const descPlain = textoOuVazio(liveDescription?.plain_text);
          if (descPlain) {
            await supabase.from("marketplace_listing_descriptions").upsert(
              {
                user_id: user.id,
                listing_id: listingId,
                plain_text: descPlain,
                html_text: descPlain,
                raw_json: liveDescription,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "listing_id" },
            );
            descriptionRow.plain_text = descPlain;
          }
        } catch (err) {
          warnings.push(
            err && typeof err === "object" && err.code === "timeout"
              ? "description_live_timeout"
              : "description_live_unavailable",
          );
        }
      }
    } catch (err) {
      warnings.push(
        err && typeof err === "object" && err.code === "timeout"
          ? "ml_sync_timeout"
          : "live_sync_unavailable",
      );
      logListingDetail("ml_sync_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const healthRow = externalListingId
    ? await loadListingHealthRowCompat(supabase, user.id, String(listingRow.marketplace), externalListingId)
    : null;
  if (!healthRow) {
    warnings.push("health_unavailable");
  }

  const listingVirtualStockLoad = await carregarListingVirtualStockSettings(
    supabase,
    user.id,
    listingId,
    /** @type {Record<string, unknown>} */ (listingRow),
  );
  const listingVirtualStockSettings = listingVirtualStockLoad.settings;

  const listingPrimaryPictureLoad = await carregarListingPrimaryPictureSettings(
    supabase,
    user.id,
    listingId,
    /** @type {Record<string, unknown>} */ (listingRow),
  );
  const listingPrimaryPictureSettings = listingPrimaryPictureLoad.settings;

  const listingLocalDescriptionLoad = await carregarListingLocalDescriptionSettings(
    supabase,
    user.id,
    listingId,
    /** @type {Record<string, unknown>} */ (listingRow),
  );
  const listingLocalDescriptionSettings = listingLocalDescriptionLoad.settings;

  const listingLocalMeasurementLoad = await carregarListingLocalMeasurementSettings(
    supabase,
    user.id,
    listingId,
    /** @type {Record<string, unknown>} */ (listingRow),
  );
  const listingLocalMeasurementSettings = listingLocalMeasurementLoad.settings;
  if (!textoOuVazio(rawItem.category_name) && textoOuVazio(rawItem.category_id)) {
    warnings.push("category_name_unavailable");
  }

  /** @type {number | null} */
  let visitsTotal = null;
  let visitsAvailable = false;
  /** @type {Record<string, unknown> | null} */
  let performancePayload = null;
  /** @type {string | null} */
  let performanceSource = null;
  /** @type {Record<string, unknown> | null} */
  let purchaseExperiencePayload = null;
  /** @type {Record<string, unknown> | null} */
  let itemFullDetailPayload = null;
  /** @type {Record<string, unknown> | null} */
  let itemPricesShowAllPayload = null;

  if (externalListingId && mlToken) {
    logListingDetail("visits_start", { listing_id: listingId, external_listing_id: externalListingId });
    try {
      const visitsResult = await withTimeout(
        fetchItemVisitsTotal(mlToken, externalListingId),
        5000,
        "ml_fetch_visits",
      );
      if (visitsResult.total != null) {
        visitsTotal = visitsResult.total;
        visitsAvailable = true;
        logListingDetail("visits_success", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          visits: visitsTotal,
        });
      } else {
        warnings.push("visits_unavailable");
        logListingDetail("visits_error", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          reason: "empty_response",
        });
      }
    } catch (err) {
      warnings.push(
        err && typeof err === "object" && err.code === "timeout" ? "visits_timeout" : "visits_unavailable",
      );
      logListingDetail("visits_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logListingDetail("performance_start", { listing_id: listingId, external_listing_id: externalListingId });
    try {
      const performanceResult = await withTimeout(
        fetchItemListingPerformance(mlToken, externalListingId),
        5000,
        "ml_fetch_performance",
      );
      if (performanceResult.payload) {
        performancePayload = performanceResult.payload;
        performanceSource = performanceResult.source;
        logListingDetail("performance_success", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          source: performanceSource,
          score: performancePayload.score ?? null,
          level: performancePayload.level ?? null,
        });
      } else {
        warnings.push("quality_unavailable");
        logListingDetail("performance_error", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: performanceResult.httpStatus,
          reason: performanceResult.httpStatus === 404 ? "not_found_performance" : "empty_response",
        });
      }
    } catch (err) {
      warnings.push("quality_unavailable");
      logListingDetail("performance_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logListingDetail("purchase_experience_start", {
      listing_id: listingId,
      external_listing_id: externalListingId,
    });
    try {
      const purchaseExperienceResult = await withTimeout(
        fetchItemPurchaseExperienceIntegrators(mlToken, externalListingId),
        5000,
        "ml_fetch_purchase_experience",
      );
      if (purchaseExperienceResult.payload) {
        purchaseExperiencePayload = purchaseExperienceResult.payload;
        const reputation =
          purchaseExperiencePayload.reputation &&
          typeof purchaseExperiencePayload.reputation === "object"
            ? /** @type {Record<string, unknown>} */ (purchaseExperiencePayload.reputation)
            : null;
        logListingDetail("purchase_experience_success", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: purchaseExperienceResult.httpStatus,
          score: reputation?.value ?? null,
          label:
            extrairTextoMlResumo(reputation?.text) ??
            extrairTextoMlResumo(purchaseExperiencePayload.title) ??
            null,
          color: reputation?.color ?? null,
        });
      } else {
        warnings.push("purchase_experience_unavailable");
        logListingDetail("purchase_experience_error", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: purchaseExperienceResult.httpStatus,
          reason: "empty_response",
        });
      }
    } catch (err) {
      warnings.push("purchase_experience_unavailable");
      logListingDetail("purchase_experience_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logListingDetail("item_full_detail_start", { listing_id: listingId, external_listing_id: externalListingId });
    try {
      const itemDetailResult = await withTimeout(
        fetchMercadoLivreItemFullDetail({ accessToken: mlToken, itemId: externalListingId }),
        5000,
        "ml_fetch_item_full_detail",
      );
      itemFullDetailPayload = /** @type {Record<string, unknown>} */ (itemDetailResult);
      if (itemDetailResult.ok && itemDetailResult.data) {
        rawItem = { ...rawItem, ...itemDetailResult.data };
        logListingDetail("item_full_detail_success", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: itemDetailResult.status,
          has_video_id: textoOuVazio(itemDetailResult.data.video_id) !== "",
        });
      } else {
        logListingDetail("item_full_detail_unavailable", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: itemDetailResult.status,
          error_code: itemDetailResult.error_code,
        });
      }
    } catch (err) {
      itemFullDetailPayload = {
        ok: false,
        status: null,
        data: null,
        error_code: err instanceof Error ? err.message : "fetch_error",
      };
      logListingDetail("item_full_detail_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logListingDetail("prices_show_all_start", { listing_id: listingId, external_listing_id: externalListingId });
    try {
      const pricesResult = await withTimeout(
        fetchMercadoLivreItemPricesShowAll({ accessToken: mlToken, itemId: externalListingId }),
        5000,
        "ml_fetch_prices_show_all",
      );
      itemPricesShowAllPayload = /** @type {Record<string, unknown>} */ (pricesResult);
      if (pricesResult.ok && pricesResult.data) {
        const prices = Array.isArray(pricesResult.data.prices) ? pricesResult.data.prices : [];
        logListingDetail("prices_show_all_success", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: pricesResult.status,
          show_all_prices_sent: pricesResult.show_all_prices_sent,
          prices_count: prices.length,
        });
      } else {
        logListingDetail("prices_show_all_unavailable", {
          listing_id: listingId,
          external_listing_id: externalListingId,
          http_status: pricesResult.status,
          show_all_prices_sent: pricesResult.show_all_prices_sent,
          error_code: pricesResult.error_code,
        });
      }
    } catch (err) {
      itemPricesShowAllPayload = {
        ok: false,
        status: null,
        data: null,
        error_code: err instanceof Error ? err.message : "fetch_error",
        show_all_prices_sent: true,
      };
      logListingDetail("prices_show_all_error", {
        listing_id: listingId,
        external_listing_id: externalListingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (externalListingId && !mlToken) {
    warnings.push("visits_unavailable");
    warnings.push("quality_unavailable");
  }

  /** @type {Record<string, unknown> | null} */
  let payload = null;
  try {
    payload = adapter.buildDetailPayload(
      /** @type {Record<string, unknown>} */ (listingRow),
      rawItem,
      descriptionRow,
      pictureRows ?? [],
      {
        healthRow,
        visitsTotal,
        visitsAvailable,
        performancePayload,
        performanceSource,
        purchaseExperiencePayload,
        itemFullDetailPayload,
        itemPricesShowAllPayload,
      },
    );
  } catch (err) {
    warnings.push("adapter_payload_unavailable");
    logListingDetail("adapter_error", {
      listing_id: listingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let productContext = null;
  try {
    productContext = await carregarContextoProdutoListingEditor(
      supabase,
      user.id,
      /** @type {Record<string, unknown>} */ (listingRow),
      rawItem,
      { listingVirtualStockSettings },
    );
  } catch (err) {
    warnings.push("product_context_unavailable");
    logListingDetail("product_context_error", {
      listing_id: listingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (payload && productContext) {
    const summaryBase =
      payload.summary && typeof payload.summary === "object" ? payload.summary : {};
    payload = {
      ...payload,
      product_summary: productContext.product_summary,
      costs_summary: productContext.costs_summary,
      stock_summary: productContext.stock_summary,
      summary: {
        ...summaryBase,
        brand: productContext.summary_fields.brand ?? summaryBase.brand ?? null,
        model: productContext.summary_fields.model ?? summaryBase.model ?? null,
        ean_gtin: productContext.summary_fields.ean_gtin ?? summaryBase.universal_code ?? null,
        universal_code:
          productContext.summary_fields.ean_gtin ?? summaryBase.universal_code ?? null,
        ncm: productContext.summary_fields.ncm ?? summaryBase.ncm ?? null,
      },
    };
  }

  /** @type {Record<string, unknown> | null} */
  let imagesSummary = null;
  if (payload) {
    try {
      const contentPayload =
        payload.content && typeof payload.content === "object" ? payload.content : {};
      const contentPictures = Array.isArray(contentPayload.pictures) ? contentPayload.pictures : [];
      const variationsPayload = Array.isArray(payload.variations) ? payload.variations : [];
      const hasVariations =
        variationsPayload.length > 0 ||
        (Array.isArray(rawItem.variations) && rawItem.variations.length > 0);
      const categoryId = textoOuVazio(rawItem.category_id) || null;
      const categoryName = textoOuVazio(rawItem.category_name) || null;
      /** @type {Map<string, Record<string, unknown> | null>} */
      const categoryCache = new Map();

      const imagesPolicy = await resolveListingImagesPolicy({
        marketplace: listingRow.marketplace,
        categoryId,
        categoryName,
        listingType: listingRow.listing_type_id,
        hasVariations,
        accessToken: mlToken,
        categoryCache,
      });

      imagesSummary = buildListingImagesSummary({
        pictures: contentPictures,
        policy: imagesPolicy,
        categoryId,
        categoryName: categoryName || imagesPolicy.categoryName,
        primaryPictureSettings:
          listingPrimaryPictureSettings && typeof listingPrimaryPictureSettings === "object"
            ? {
                primary_picture_id: listingPrimaryPictureSettings.primary_picture_id,
                primary_picture_url: listingPrimaryPictureSettings.primary_picture_url,
                ordered_picture_keys: listingPrimaryPictureSettings.ordered_picture_keys,
              }
            : null,
      });
      payload = { ...payload, images_summary: imagesSummary };
    } catch (err) {
      warnings.push("images_summary_unavailable");
      logListingDetail("images_summary_error", {
        listing_id: listingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const safePayload = buildSafeDetailPayload(payload, listingRow, rawItem);
  if (productContext) {
    safePayload.product_summary = productContext.product_summary;
    safePayload.costs_summary = productContext.costs_summary;
    safePayload.stock_summary = productContext.stock_summary;
    if (safePayload.summary && typeof safePayload.summary === "object") {
      safePayload.summary = {
        ...safePayload.summary,
        brand: productContext.summary_fields.brand ?? safePayload.summary.brand ?? null,
        model: productContext.summary_fields.model ?? safePayload.summary.model ?? null,
        ean_gtin: productContext.summary_fields.ean_gtin ?? safePayload.summary.universal_code ?? null,
        universal_code:
          productContext.summary_fields.ean_gtin ?? safePayload.summary.universal_code ?? null,
        ncm: productContext.summary_fields.ncm ?? safePayload.summary.ncm ?? null,
      };
    }
  }
  if (imagesSummary) {
    safePayload.images_summary = imagesSummary;
  }

  /** @type {Record<string, unknown> | null} */
  let descriptionSummary = null;
  if (payload) {
    try {
      const contentPayload =
        payload.content && typeof payload.content === "object" ? payload.content : {};
      const marketplaceDescription =
        textoOuVazio(descriptionRow?.plain_text) ||
        textoOuVazio(descriptionRow?.html_text) ||
        textoOuVazio(contentPayload.description) ||
        null;
      descriptionSummary = buildListingDescriptionSummary({
        marketplaceDescription,
        localDescription:
          listingLocalDescriptionSettings && typeof listingLocalDescriptionSettings === "object"
            ? listingLocalDescriptionSettings.description_text
            : null,
      });
      if (payload.content && typeof payload.content === "object") {
        payload = {
          ...payload,
          content: {
            ...contentPayload,
            description: descriptionSummary.effective_description || null,
          },
        };
      }
      payload = { ...payload, description_summary: descriptionSummary };
    } catch (err) {
      warnings.push("description_summary_unavailable");
      logListingDetail("description_summary_error", {
        listing_id: listingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (descriptionSummary) {
    safePayload.description_summary = descriptionSummary;
    if (safePayload.content && typeof safePayload.content === "object") {
      safePayload.content = {
        ...safePayload.content,
        description: descriptionSummary.effective_description || null,
      };
    }
  }

  /** @type {Record<string, unknown> | null} */
  let measurementsSummary = null;
  try {
    const marketplaceMeasurements = resolveListingMarketplaceMeasurements(
      textoOuVazio(listingRow.marketplace),
      rawItem,
    );
    const productMeasurements =
      productContext?.product_measurements && typeof productContext.product_measurements === "object"
        ? productContext.product_measurements
        : { shipping: {}, product_mounted: {} };

    measurementsSummary = buildListingMeasurementsSummary({
      marketplaceMeasurements,
      productMeasurements,
      localMeasurements:
        listingLocalMeasurementSettings && typeof listingLocalMeasurementSettings === "object"
          ? listingLocalMeasurementSettings
          : null,
    });
    payload = payload ? { ...payload, measurements_summary: measurementsSummary } : payload;
  } catch (err) {
    warnings.push("measurements_summary_unavailable");
    logListingDetail("measurements_summary_error", {
      listing_id: listingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (measurementsSummary) {
    safePayload.measurements_summary = measurementsSummary;
  }

  if (safePayload?.quality?.source === "unavailable" && !warnings.includes("quality_unavailable")) {
    warnings.push("quality_unavailable");
  }
  if (safePayload?.purchase_experience?.source === "unavailable") {
    warnings.push("purchase_experience_unavailable");
  }
  const responseEvent = warnings.length > 0 ? "response_partial" : "response_success";
  logListingDetail(responseEvent, {
    listing_id: listingId,
    warnings_count: warnings.length,
  });

  return res.status(200).json({
    ok: true,
    partial: warnings.length > 0,
    listing_id: listingRow.id,
    listing_external_id: listingRow.external_listing_id,
    marketplace: adapter.marketplace,
    detail: safePayload,
    summary: safePayload?.summary ?? null,
    quality: safePayload?.quality ?? null,
    purchase_experience: safePayload?.purchase_experience ?? null,
    product_summary: safePayload?.product_summary ?? null,
    costs_summary: safePayload?.costs_summary ?? null,
    stock_summary: safePayload?.stock_summary ?? null,
    images_summary: safePayload?.images_summary ?? null,
    description_summary: safePayload?.description_summary ?? null,
    measurements_summary: safePayload?.measurements_summary ?? null,
    marketplace_edit_url: safePayload?.marketplace_edit_url ?? null,
    external_edit_url: safePayload?.external_edit_url ?? safePayload?.marketplace_edit_url ?? null,
    warnings,
  });
}

