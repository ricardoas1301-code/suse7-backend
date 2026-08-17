// ======================================================================
// Montagem batch — Central de Saúde dos Anúncios (Dashboard).
// SSOT: grid ML + métricas executivas + classificador compartilhado.
// ======================================================================

import Decimal from "decimal.js";
import { buildListingGridRow, ensureListingGridMoneyContract } from "../../handlers/ml/_helpers/listingGridAssembler.js";
import {
  firstProductImageUrlFromJoin,
  resolveGalleryImageUrlsForListing,
  resolveMercadoLibreListingCoverImageUrl,
} from "../../handlers/ml/_helpers/mercadoLibreListingCoverImage.js";
import {
  getListingGridRow,
  putListingGridRowAliases,
} from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { fetchAllListingHealthRowsCompat } from "../../handlers/ml/_helpers/mlHealthSchemaCompat.js";
import {
  finalizeListingGridAccountFields,
  loadMarketplaceAccountMetaMap,
  resolveMarketplaceAccountDisplayName,
  resolveMarketplaceAccountDisplayNameById,
} from "../../handlers/ml/_helpers/listingGridAccountEnrich.js";
import {
  buildOfficialListingMetricsMap,
  exposeOfficialListingFinancialMetrics,
} from "../../handlers/ml/listingsList.js";
import { normalizeMercadoLibreExternalListingId } from "../../handlers/ml/_helpers/mercadoLibreListingCoverImage.js";
import { normalizeMercadoLivreListingHealthSnapshot } from "../listings/health/adapters/mercadoLivreListingHealthAdapter.js";
import {
  montarClassificacaoCompletaAnuncio,
  anuncioPrecisaAtencao,
  anuncioEmRiscoEstoque,
} from "../listings/health/listingHealthClassifier.js";
import {
  montarDistribuicaoSaudeCadastro,
  buildEmptyRegistrationHealthDistribution,
} from "../listings/health/listingRegistrationDistribution.js";
import {
  montarDistribuicaoSaudeOperacional,
  buildEmptyOperationalHealthDistribution,
} from "../listings/health/listingOperationalDistribution.js";
import {
  montarDistribuicaoSaudeComercial,
  buildEmptyCommercialHealthDistribution,
} from "../listings/health/listingCommercialDistribution.js";
import { logListingHealthDashboard } from "../listings/health/listingHealthBucketEngine.js";

/** Período lifetime — saúde comercial consolidada desde a importação. */
const COMMERCIAL_HEALTH_LIFETIME_PERIOD = {
  preset: "lifetime",
  start_ms: null,
  end_ms_exclusive: null,
  start_date: null,
  end_date: null,
};

const LOG_PREFIX = "[S7_LISTINGS_HEALTH_SUMMARY]";

/**
 * Monta summary_cards inferiores — SSOT alinhada aos motores operacional/comercial.
 *
 * @param {{
 *   totalListings: number;
 *   operationalDistribution: ReturnType<typeof montarDistribuicaoSaudeOperacional>;
 *   commercialDistribution: ReturnType<typeof montarDistribuicaoSaudeComercial>;
 *   attentionCount: number;
 * }} input
 */
export function montarSummaryCardsCentralSaude({
  totalListings,
  operationalDistribution,
  commercialDistribution,
  attentionCount,
}) {
  const pausedCount = operationalDistribution.paused_count ?? 0;
  const inactiveCount = operationalDistribution.inactive_count ?? 0;
  const offlineCount = operationalDistribution.offline_count ?? pausedCount + inactiveCount;
  const activeWithSalesCount = commercialDistribution.active_with_sales_count ?? 0;
  const activeWithoutSalesCount = commercialDistribution.active_without_sales_count ?? 0;
  const activeCount = activeWithSalesCount + activeWithoutSalesCount;

  return {
    active_count: activeCount,
    offline_count: offlineCount,
    paused_count: pausedCount,
    inactive_count: inactiveCount,
    active_with_sales_count: activeWithSalesCount,
    active_without_sales_count: activeWithoutSalesCount,
    attention_count: attentionCount,
    total_listings: totalListings,
    buckets_sum:
      activeWithSalesCount + activeWithoutSalesCount + offlineCount,
  };
}

/** @param {string} label @param {Record<string, unknown>} [payload] */
function logListingsHealthSummary(label, payload = {}) {
  console.info(`${LOG_PREFIX} ${label}`, payload);
}

/** @param {string} stage @param {unknown} error */
function logListingsHealthSummaryFailed(stage, error) {
  const err = error instanceof Error ? error : new Error(String(error ?? "unknown"));
  console.error(`${LOG_PREFIX} failed`, {
    stage,
    message: err.message,
    stack: err.stack,
  });
}

/**
 * Payload vazio seguro — Dashboard nunca quebra por ausência de dados.
 * @param {Record<string, unknown>} [metadata]
 */
export function buildEmptyListingsHealthSummaryPayload(metadata = {}) {
  return {
    ok: true,
    source: "dashboard-listings-health-summary-ssot",
    metadata,
    summary: {
      total_listings: 0,
      active_count: 0,
      paused_count: 0,
      inactive_count: 0,
      average_health_percent: "0.00",
      needs_attention_count: 0,
      stock_risk_count: 0,
      zero_stock_count: 0,
      critical_stock_count: 0,
      negative_profit_count: 0,
      critical_margin_count: 0,
      active_without_sales_count: 0,
      active_with_sales_count: 0,
      offline_count: 0,
      registration_needs_improvement_count: 0,
    },
    summary_cards: {
      active_count: 0,
      offline_count: 0,
      paused_count: 0,
      inactive_count: 0,
      active_with_sales_count: 0,
      active_without_sales_count: 0,
      attention_count: 0,
    },
    cards: {
      registration_health: buildEmptyRegistrationHealthDistribution(),
      operational_health: buildEmptyOperationalHealthDistribution(),
      commercial_health: buildEmptyCommercialHealthDistribution(),
    },
  };
}

const LISTINGS_SELECT_BASE =
  "id, title, marketplace, marketplace_account_id, price, base_price, original_price, available_quantity, sold_quantity, status, external_listing_id, permalink, health, api_last_seen_at, currency_id, pictures_count, variations_count, seller_sku, seller_custom_field, listing_type_id, raw_json, product_id, financial_analysis_blocked, needs_attention, attention_reason, products(catalog_completeness, product_images, product_name, sku, cost_price, operational_cost, packaging_cost)";
const LISTINGS_SELECT_WITH_ACCOUNT = `${LISTINGS_SELECT_BASE}, marketplace_accounts(account_alias, ml_nickname)`;

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ marketplaceAccountId?: string | null; marketplace?: string | null; commercialPreset?: string; dateFrom?: string | null; dateTo?: string | null }} [options]
 */
export async function buildListingsHealthSummary(supabase, userId, options = {}) {
  const marketplaceAccountId = String(options.marketplaceAccountId ?? "").trim();
  const marketplaceFilter = String(options.marketplace ?? "").trim().toLowerCase();

  logListingsHealthSummary("started", {
    user_id: userId,
    marketplace_account_id: marketplaceAccountId || null,
    marketplace: marketplaceFilter || null,
    commercial_scope: "lifetime",
  });

  let data;
  let error;
  ({ data, error } = await supabase
    .from("marketplace_listings")
    .select(LISTINGS_SELECT_WITH_ACCOUNT)
    .eq("user_id", userId)
    .order("api_last_seen_at", { ascending: false }));

  if (error) {
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (errMsg.includes("marketplace_accounts") || String(error?.code ?? "") === "PGRST200") {
      ({ data, error } = await supabase
        .from("marketplace_listings")
        .select(LISTINGS_SELECT_BASE)
        .eq("user_id", userId)
        .order("api_last_seen_at", { ascending: false }));
    }
  }
  if (error) throw error;

  let listings = (data ?? []).map((row) => {
    const { products: prodRel, marketplace_accounts: accRel, ...rest } = row;
    const accJoined = Array.isArray(accRel) && accRel[0] ? accRel[0] : accRel;
    const joinedAccountAlias =
      accJoined && typeof accJoined === "object"
        ? resolveMarketplaceAccountDisplayName(/** @type {Record<string, unknown>} */ (accJoined), {
            allowFallback: false,
          })
        : null;
    const product_catalog_completeness =
      prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
        ? /** @type {{ catalog_completeness?: string }} */ (prodRel).catalog_completeness ?? null
        : Array.isArray(prodRel) && prodRel[0]
          ? /** @type {{ catalog_completeness?: string }} */ (prodRel[0]).catalog_completeness ?? null
          : null;
    const product_cover_url = firstProductImageUrlFromJoin(prodRel);
    const pr =
      prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
        ? /** @type {Record<string, unknown>} */ (prodRel)
        : Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
          ? /** @type {Record<string, unknown>} */ (prodRel[0])
          : null;
    const product_cost_row =
      pr != null
        ? {
            cost_price: pr.cost_price,
            operational_cost: pr.operational_cost,
            packaging_cost: pr.packaging_cost,
          }
        : null;
    const product_name =
      pr != null && pr.product_name != null && String(pr.product_name).trim() !== ""
        ? String(pr.product_name).trim()
        : null;
    const product_sku =
      pr != null && pr.sku != null && String(pr.sku).trim() !== "" ? String(pr.sku).trim() : null;
    return {
      ...rest,
      product_catalog_completeness,
      product_cover_url,
      product_cost_row,
      product_name,
      product_sku,
      joined_account_alias: joinedAccountAlias,
    };
  });

  if (marketplaceAccountId) {
    listings = listings.filter(
      (l) => String(l.marketplace_account_id ?? "").trim() === marketplaceAccountId,
    );
  }
  if (marketplaceFilter) {
    listings = listings.filter((l) => {
      const m = String(l.marketplace ?? "").toLowerCase();
      if (marketplaceFilter === "mercadolivre") return m === "mercado_livre" || m === "mercadolivre";
      return m === marketplaceFilter;
    });
  }

  logListingsHealthSummary("listings_loaded", {
    listings_count: listings.length,
  });

  if (listings.length === 0) {
    logListingsHealthSummary("cards_built", { listings_count: 0, reason: "no_listings_after_filters" });
    return buildEmptyListingsHealthSummaryPayload({
      registration_health_scope: "current_state",
      operational_health_scope: "current_state",
      commercial_health_scope: "lifetime",
      marketplace_account_id: marketplaceAccountId || null,
      marketplace: marketplaceFilter || null,
    });
  }

  const accountById = await loadMarketplaceAccountMetaMap(supabase, userId);
  for (const listing of listings) {
    const accountId =
      listing.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
        ? String(listing.marketplace_account_id).trim()
        : "";
    if (!accountId) continue;
    listing.joined_account_alias = resolveMarketplaceAccountDisplayNameById(accountId, accountById);
  }

  const listingIds = listings.map((l) => l.id).filter(Boolean);
  const healthLoad = await fetchAllListingHealthRowsCompat(supabase, userId);
  const healthRows = healthLoad.data ?? [];

  /** @type {Map<string, Record<string, unknown>>} */
  const healthByKey = new Map();
  for (const h of healthRows) {
    putListingGridRowAliases(healthByKey, h.marketplace, h, (r) => r.external_listing_id);
  }

  /** @type {Map<string, Array<{ secure_url?: unknown; url?: unknown; position?: unknown; raw_json?: unknown }>>} */
  const pictureRowsByListingId = new Map();
  if (listingIds.length > 0) {
    const { data: picRows } = await supabase
      .from("marketplace_listing_pictures")
      .select("listing_id, secure_url, url, position, raw_json")
      .in("listing_id", listingIds)
      .order("position", { ascending: true });
    for (const p of picRows || []) {
      const lid = p.listing_id;
      if (lid == null || lid === "") continue;
      const key = String(lid);
      if (!pictureRowsByListingId.has(key)) pictureRowsByListingId.set(key, []);
      pictureRowsByListingId.get(key)?.push(p);
    }
  }

  const { data: metricsRows } = await supabase
    .from("listing_sales_metrics")
    .select(
      "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, commission_amount_total, shipping_share_total, orders_count, last_sale_at",
    )
    .eq("user_id", userId);

  /** @type {Map<string, Record<string, unknown>>} */
  const metricsByKey = new Map();
  for (const m of metricsRows || []) {
    putListingGridRowAliases(metricsByKey, m.marketplace, m, (r) => r.external_listing_id);
  }

  const { data: profileTaxRow } = await supabase
    .from("profiles")
    .select("imposto_percentual")
    .eq("id", userId)
    .maybeSingle();
  const sellerTaxPct =
    profileTaxRow?.imposto_percentual != null && String(profileTaxRow.imposto_percentual).trim() !== ""
      ? String(profileTaxRow.imposto_percentual).trim()
      : null;

  const gridRows = listings.map((l) => {
    try {
      const met = getListingGridRow(metricsByKey, l.marketplace, l.external_listing_id);
      const hlth = getListingGridRow(healthByKey, l.marketplace, l.external_listing_id);
      const pictureRows =
        l.id != null && l.id !== "" ? pictureRowsByListingId.get(String(l.id)) ?? [] : [];
      const cover_thumbnail_url = resolveMercadoLibreListingCoverImageUrl({
        listing: /** @type {Record<string, unknown>} */ (l),
        pictureRows,
        productMainImageUrl: l.product_cover_url ?? null,
      });
      const row = /** @type {Record<string, unknown>} */ (
        buildListingGridRow(String(l.marketplace), l, met, hlth, cover_thumbnail_url, { sellerTaxPct })
      );
      const gallery = resolveGalleryImageUrlsForListing(pictureRows, l.raw_json, 12);
      if (
        (row.cover_thumbnail_url == null || String(row.cover_thumbnail_url).trim() === "") &&
        gallery.urls.length > 0
      ) {
        row.cover_thumbnail_url = gallery.urls[0];
        row.cover_image_url = gallery.urls[0];
      }
      const accountId =
        l.marketplace_account_id != null && String(l.marketplace_account_id).trim() !== ""
          ? String(l.marketplace_account_id).trim()
          : null;
      row.marketplace_account_id = accountId;
      row.account_alias =
        accountId != null
          ? resolveMarketplaceAccountDisplayNameById(accountId, accountById)
          : l.joined_account_alias ?? null;
      return ensureListingGridMoneyContract(row);
    } catch (gridErr) {
      logListingsHealthSummaryFailed("grid_row_build", {
        listing_id: l?.id ?? null,
        external_listing_id: l?.external_listing_id ?? null,
        cause: gridErr,
      });
      return ensureListingGridMoneyContract({
        id: l?.id != null ? String(l.id) : "",
        external_listing_id: l?.external_listing_id != null ? String(l.external_listing_id) : "",
        title: l?.title != null ? String(l.title) : "Anúncio sem título",
        status: l?.status != null ? String(l.status) : null,
        available_quantity: l?.available_quantity ?? null,
        marketplace: l?.marketplace != null ? String(l.marketplace) : null,
      });
    }
  });

  /** @type {Map<string, Record<string, unknown>>} */
  let executiveMetricsById = new Map();
  try {
    executiveMetricsById = await buildOfficialListingMetricsMap(
      supabase,
      userId,
      /** @type {Record<string, unknown>[]} */ (listings),
      { period: COMMERCIAL_HEALTH_LIFETIME_PERIOD },
    );
    logListingsHealthSummary("financial_metrics_loaded", {
      metrics_rows: executiveMetricsById.size,
    });
  } catch (metricsErr) {
    logListingsHealthSummaryFailed("financial_metrics", metricsErr);
  }

  /** @type {Array<{ snapshot: ReturnType<typeof normalizeMercadoLivreListingHealthSnapshot>; classification: ReturnType<typeof montarClassificacaoCompletaAnuncio>; listingRow: Record<string, unknown>; gridRow: Record<string, unknown> }>} */
  const enriched = [];

  for (let i = 0; i < listings.length; i += 1) {
    try {
      const listingRow = /** @type {Record<string, unknown>} */ (listings[i]);
      const gridRow = /** @type {Record<string, unknown>} */ (gridRows[i]);
      const externalListingId =
        gridRow.external_listing_id != null && String(gridRow.external_listing_id).trim() !== ""
          ? String(gridRow.external_listing_id).trim()
          : "";
      const hlth = getListingGridRow(healthByKey, listingRow.marketplace, listingRow.external_listing_id);
      const metric =
        executiveMetricsById.get(externalListingId) ??
        executiveMetricsById.get(normalizeMercadoLibreExternalListingId(externalListingId));
      exposeOfficialListingFinancialMetrics(gridRow, metric);

      const snapshot = normalizeMercadoLivreListingHealthSnapshot({
        listingRow,
        gridRow,
        healthRow: hlth,
        financialMetric: metric,
      });
      const classification = montarClassificacaoCompletaAnuncio(snapshot);
      enriched.push({ snapshot, classification, listingRow, gridRow });
    } catch (rowErr) {
      logListingsHealthSummaryFailed("listing_enrich", {
        index: i,
        listing_id: listings[i]?.id ?? null,
        cause: rowErr,
      });
    }
  }

  try {
    await finalizeListingGridAccountFields(
      supabase,
      userId,
      gridRows,
      /** @type {Record<string, unknown>[]} */ (listings),
      accountById,
      null,
    );
  } catch (finalizeErr) {
    logListingsHealthSummaryFailed("finalize_account_fields", finalizeErr);
  }

  let totalListings = enriched.length;
  let needsAttentionCount = 0;
  /** @type {Set<string>} */
  const needsAttentionIds = new Set();
  let stockRiskCount = 0;
  let zeroStockCount = 0;
  let criticalStockCount = 0;
  let registrationNeedsImprovementCount = 0;

  let healthScoreSum = new Decimal(0);
  let healthScoreCount = 0;

  for (const item of enriched) {
    const { snapshot, classification } = item;
    const operacional = classification.operacional;
    const cadastro = classification.cadastro;

    if (cadastro.needs_improvement) registrationNeedsImprovementCount += 1;
    if (operacional.is_zero_stock) zeroStockCount += 1;
    if (operacional.is_critical_stock) criticalStockCount += 1;

    if (anuncioPrecisaAtencao(snapshot)) {
      const listingId =
        snapshot.listing_id != null && String(snapshot.listing_id).trim() !== ""
          ? String(snapshot.listing_id).trim()
          : `idx-${needsAttentionIds.size}`;
      if (!needsAttentionIds.has(listingId)) {
        needsAttentionIds.add(listingId);
        needsAttentionCount += 1;
      }
    }
    if (anuncioEmRiscoEstoque(snapshot)) stockRiskCount += 1;

    if (snapshot.health_score != null) {
      healthScoreSum = healthScoreSum.plus(snapshot.health_score);
      healthScoreCount += 1;
    }
  }

  const averageHealthPercent =
    healthScoreCount > 0
      ? healthScoreSum.div(healthScoreCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : "0.00";

  const registrationDistribution = montarDistribuicaoSaudeCadastro(
    enriched.map((item) => item.snapshot),
    { total_needs_improvement: registrationNeedsImprovementCount },
  );

  const operationalDistribution = montarDistribuicaoSaudeOperacional(
    enriched.map((item) => item.snapshot),
  );

  const commercialDistribution = montarDistribuicaoSaudeComercial(
    enriched.map((item) => item.snapshot),
  );

  const activeWithSalesCount = commercialDistribution.active_with_sales_count ?? 0;
  const activeWithoutSalesCount = commercialDistribution.active_without_sales_count ?? 0;
  const summaryCards = montarSummaryCardsCentralSaude({
    totalListings,
    operationalDistribution,
    commercialDistribution,
    attentionCount: needsAttentionCount,
  });
  const { active_count: activeCount, offline_count: offlineCount, paused_count: pausedCount, inactive_count: inactiveCount } =
    summaryCards;

  logListingHealthDashboard("cadastro buckets sum", {
    buckets_sum: registrationDistribution.buckets_sum,
    total_listings: totalListings,
  });
  logListingHealthDashboard("operacional buckets sum", {
    buckets_sum: operationalDistribution.buckets_sum,
    total_listings: totalListings,
  });
  logListingHealthDashboard("comercial buckets sum", {
    buckets_sum: commercialDistribution.buckets_sum,
    total_listings: totalListings,
  });

  logListingsHealthSummary("cards_built", {
    listings_count: totalListings,
    enriched_count: enriched.length,
    registration_distribution_total: registrationDistribution.total_listings,
    operational_distribution_total: operationalDistribution.total_listings,
    commercial_distribution_total: commercialDistribution.total_listings,
    needs_attention_count: needsAttentionCount,
    active_with_sales_count: activeWithSalesCount,
    active_without_sales_count: activeWithoutSalesCount,
    offline_count: offlineCount,
  });

  return {
    ok: true,
    source: "dashboard-listings-health-summary-ssot",
    metadata: {
      registration_health_scope: "current_state",
      operational_health_scope: "current_state",
      commercial_health_scope: "lifetime",
      marketplace_account_id: marketplaceAccountId || null,
      marketplace: marketplaceFilter || null,
    },
    summary: {
      total_listings: totalListings,
      active_count: activeCount,
      paused_count: pausedCount,
      inactive_count: inactiveCount,
      average_health_percent: averageHealthPercent,
      needs_attention_count: needsAttentionCount,
      stock_risk_count: stockRiskCount,
      zero_stock_count: zeroStockCount,
      critical_stock_count: criticalStockCount,
      negative_profit_count: commercialDistribution.negative_profit_count,
      critical_margin_count: commercialDistribution.critical_margin_count,
      active_without_sales_count: activeWithoutSalesCount,
      active_with_sales_count: activeWithSalesCount,
      offline_count: offlineCount,
      registration_needs_improvement_count: registrationNeedsImprovementCount,
    },
    summary_cards: {
      active_count: summaryCards.active_count,
      offline_count: summaryCards.offline_count,
      paused_count: summaryCards.paused_count,
      inactive_count: summaryCards.inactive_count,
      active_with_sales_count: summaryCards.active_with_sales_count,
      active_without_sales_count: summaryCards.active_without_sales_count,
      attention_count: summaryCards.attention_count,
    },
    cards: {
      registration_health: {
        title: "Saúde do cadastro",
        total_listings: registrationDistribution.total_listings,
        total_needs_improvement: registrationDistribution.total_needs_improvement,
        below_100_count: registrationDistribution.below_100_count,
        buckets_sum: registrationDistribution.buckets_sum,
        unclassified_count: registrationDistribution.unclassified_count,
        distribution: registrationDistribution.distribution,
      },
      operational_health: {
        title: "Saúde operacional",
        total_listings: operationalDistribution.total_listings,
        active_count: operationalDistribution.active_count,
        zero_stock_count: operationalDistribution.zero_stock_count,
        critical_stock_count: operationalDistribution.critical_stock_count,
        paused_count: operationalDistribution.paused_count,
        inactive_count: operationalDistribution.inactive_count,
        buckets_sum: operationalDistribution.buckets_sum,
        unclassified_count: operationalDistribution.unclassified_count,
        distribution: operationalDistribution.distribution,
      },
      commercial_health: {
        title: "Saúde comercial",
        total_listings: commercialDistribution.total_listings,
        scope: commercialDistribution.scope,
        active_without_sales_count: commercialDistribution.active_without_sales_count,
        active_with_sales_count: commercialDistribution.active_with_sales_count,
        negative_profit_count: commercialDistribution.negative_profit_count,
        critical_margin_count: commercialDistribution.critical_margin_count,
        buckets_sum: commercialDistribution.buckets_sum,
        unclassified_count: commercialDistribution.unclassified_count,
        distribution: commercialDistribution.distribution,
      },
    },
  };
}
