// ======================================================
// GET /api/ml/listings
// Grid de anúncios: consolidação no backend (listingGridAssembler).
// ======================================================

import Decimal from "decimal.js";
import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import {
  buildListingGridRow,
  ensureListingGridMoneyContract,
  LISTING_GRID_MONEY_CONTRACT_VERSION,
} from "./_helpers/listingGridAssembler.js";
import {
  buildListingCoverInlineTrace,
  firstProductImageUrlFromJoin,
  LISTING_COVER_INLINE_TRACE_IDS,
  normalizeMercadoLibreExternalListingId,
  resolveGalleryImageUrlsForListing,
  resolveMercadoLibreListingCoverImageUrl,
} from "./_helpers/mercadoLibreListingCoverImage.js";
import {
  getListingGridRow,
  putListingGridRowAliases,
} from "./_helpers/listingGridJoinKeys.js";
import { maybeEnrichGridRowsWithLiveListingPrices } from "./_helpers/listingGridLiveFeeEnrich.js";
import { mercadoLivreMoneyShapeDiagnostics } from "./_helpers/mercadoLivreListingMoneyShared.js";
import { mlPriceValidateLogsEnabled } from "./_helpers/mercadoLibreItemsApi.js";
import { fetchAllListingHealthRowsCompat } from "./_helpers/mlHealthSchemaCompat.js";
import { enrichListingGridRowsWithProductCardMetrics } from "./_helpers/listingProductCardMetrics.js";
import { enrichListingGridRowsWithCompetitionMetrics, applyCompetitionMetricsFallbackToAllGridRows } from "./_helpers/listingGridCompetitionEnrich.js";
import { applyListsCurrentPriceStalenessHotfix } from "./_helpers/listingGridCurrentPriceHotfix.js";
import { buildPricingCurrentStateReadModelMissGridFallbackContract } from "../../domain/pricing/listingPricingCurrentStateReadModel.js";
import { logPricingListLoadFatal } from "../../domain/pricing/buildPricingCurrentStateEngineResilience.js";
import { enrichListingGridRowsPricingCurrentStateProjectedUnit } from "./_helpers/listingGridPricingCurrentStateEnrich.js";
import {
  externalListingIdKeyVariants,
} from "./_helpers/listingGridJoinKeys.js";
import {
  finalizeListingGridAccountFields,
  loadMarketplaceAccountMetaMap,
  resolveMarketplaceAccountDisplayName,
  resolveMarketplaceAccountDisplayNameById,
} from "./_helpers/listingGridAccountEnrich.js";
import {
  buildHistoricalCardOrderItemsAggregates,
  logHistoricalCardMetricsProbe,
} from "../../domain/sales/historicalCardOrderItemsAggregates.js";
import { computeExecutiveLineRealProfit } from "../../domain/sales/saleExecutiveLineRealResult.js";
import {
  saleDetailMoneyToDecimal,
  saleDetailToQty,
} from "../../domain/sales/saleDetailInternalCosts.js";
import { projectSkuDependencyPending } from "../../domain/listings/skuDependencyPending.js";
import { isExecutiveSummaryEligibleOrderRow } from "../../domain/sales/saleExecutiveOrderValidity.js";
import { orderMatchesExecutivePeriod } from "../../domain/sales/saleExecutivePeriod.js";
import { iterateExecutiveSummaryBatches } from "../../domain/sales/saleExecutiveSourceItems.js";

function parseMoneyDecimal(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const dec = new Decimal(String(raw).replace(",", "."));
    return dec.isFinite() ? dec : null;
  } catch {
    return null;
  }
}

function toMoneyString(raw) {
  const dec = parseMoneyDecimal(raw);
  return dec != null ? dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;
}

function toPercentString(raw) {
  const dec = parseMoneyDecimal(raw);
  return dec != null ? dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;
}

function parsePositiveInt(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function exposeOfficialListingFinancialMetrics(row, executiveMetric) {
  if (!executiveMetric || typeof executiveMetric !== "object") return;

  const grossBrl = toMoneyString(executiveMetric.gross_sales_brl);
  const profitBrl = toMoneyString(executiveMetric.contribution_profit_brl ?? executiveMetric.profit_brl);
  const profitPct = toPercentString(
    executiveMetric.contribution_margin_percent ?? executiveMetric.margin_percent
  );
  const salesCount = parsePositiveInt(executiveMetric.quantity_sold);
  const netReceivedBrl = toMoneyString(executiveMetric.net_received_brl);

  if (salesCount != null) {
    row.sold_quantity = salesCount;
    row.qty_sold_total = salesCount;
  }
  if (grossBrl != null) {
    row.gross_sales_brl = grossBrl;
    row.gross_revenue_brl = grossBrl;
    row.gross_revenue_missing = false;
  }
  if (profitBrl != null) {
    row.contribution_profit_brl = profitBrl;
    row.net_profit_brl = profitBrl;
  }
  if (profitPct != null) {
    row.contribution_margin_percent = profitPct;
  }
  if (salesCount != null && grossBrl != null) {
    const grossDec = parseMoneyDecimal(grossBrl);
    if (grossDec != null) {
      row.average_ticket_brl = grossDec.div(salesCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    }
  }
  if (netReceivedBrl != null) {
    row.you_receive_brl = netReceivedBrl;
    row.net_received_brl = netReceivedBrl;
  }
}

function putExecutiveListingMetric(map, metric) {
  if (!metric || typeof metric !== "object") return;
  const candidates = [metric.external_listing_id, metric.listing_id]
    .map((value) => (value != null ? String(value).trim() : ""))
    .filter(Boolean);
  for (const candidate of candidates) {
    map.set(candidate, metric);
    const normalized = normalizeMercadoLibreExternalListingId(candidate);
    if (normalized) map.set(normalized, metric);
  }
}

function putListingTargetAliases(map, externalListingId) {
  const canonical = externalListingId != null ? String(externalListingId).trim() : "";
  if (!canonical) return;
  for (const candidate of externalListingIdKeyVariants(canonical)) {
    map.set(candidate, canonical);
  }
}

export async function buildOfficialListingMetricsMap(supabase, userId, listings, options = {}) {
  const lifetimePeriod = options.period ?? {
    preset: "lifetime",
    start_ms: null,
    end_ms_exclusive: null,
    start_date: null,
    end_date: null,
  };
  const targetByAlias = new Map();
  for (const listing of listings || []) {
    putListingTargetAliases(targetByAlias, listing.external_listing_id);
  }
  const byListingId = new Map();
  if (targetByAlias.size === 0) return byListingId;

  for await (const batch of iterateExecutiveSummaryBatches(supabase, userId, {
    period: lifetimePeriod,
    filter: "all",
  })) {
    for (const item of batch.items || []) {
      const orderId = item?.sales_order_id != null ? String(item.sales_order_id) : "";
      const order = orderId ? batch.ordersById.get(orderId) ?? null : null;
      if (order && !isExecutiveSummaryEligibleOrderRow(order)) continue;
      if (!orderMatchesExecutivePeriod(order, lifetimePeriod, item)) continue;

      let canonicalListingId = null;
      for (const candidate of externalListingIdKeyVariants(item?.external_listing_id)) {
        const hit = targetByAlias.get(candidate);
        if (hit) {
          canonicalListingId = hit;
          break;
        }
      }
      if (!canonicalListingId) continue;

      const qty = saleDetailToQty(item.quantity);
      const grossDec = saleDetailMoneyToDecimal(item.gross_amount);
      const netDec = saleDetailMoneyToDecimal(item.net_amount) ?? grossDec;
      if (grossDec == null && netDec == null) continue;
      const grossLine = grossDec ?? new Decimal(0);
      const netLine = netDec ?? grossLine;
      const { profitDec } = computeExecutiveLineRealProfit({
        item,
        qty,
        grossDec: grossLine,
        netDec: netLine,
      });

      const prev = byListingId.get(canonicalListingId) ?? {
        quantity_sold: 0,
        gross_sales_brl: new Decimal(0),
        net_received_brl: new Decimal(0),
        contribution_profit_brl: new Decimal(0),
        profitLines: 0,
      };
      prev.quantity_sold += qty;
      prev.gross_sales_brl = prev.gross_sales_brl.plus(grossLine);
      prev.net_received_brl = prev.net_received_brl.plus(netLine);
      if (profitDec != null) {
        prev.contribution_profit_brl = prev.contribution_profit_brl.plus(profitDec);
        prev.profitLines += 1;
      }
      byListingId.set(canonicalListingId, prev);
    }
  }

  for (const [listingId, metric] of byListingId) {
    const gross = metric.gross_sales_brl;
    const profit = metric.contribution_profit_brl;
    byListingId.set(listingId, {
      listing_id: listingId,
      external_listing_id: listingId,
      quantity_sold: metric.quantity_sold,
      gross_sales_brl: gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      net_received_brl: metric.net_received_brl.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      contribution_profit_brl: profit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      contribution_margin_percent:
        metric.profitLines > 0 && !gross.isZero()
          ? profit.div(gross).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
          : "0.00",
    });
  }

  return byListingId;
}

export default async function handleMlListingsList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json({
        ok: true,
        listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
        pricing_protocol: "suse7-pricing-v1",
        listings: [],
        items: [],
        page: 1,
        page_size: 50,
        total: 0,
      });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "anuncios" })) return;

  const LISTINGS_SELECT_BASE =
    "id, title, marketplace, marketplace_account_id, price, base_price, original_price, available_quantity, sold_quantity, status, external_listing_id, permalink, health, api_last_seen_at, currency_id, pictures_count, variations_count, seller_sku, seller_custom_field, listing_type_id, raw_json, product_id, financial_analysis_blocked, needs_attention, attention_reason, products(catalog_completeness, product_images, product_name, sku, cost_price, operational_cost, packaging_cost)";
  const LISTINGS_SELECT_WITH_ACCOUNT = `${LISTINGS_SELECT_BASE}, marketplace_accounts(account_alias, ml_nickname)`;

  try {
    let data;
    let error;
    ({ data, error } = await supabase
      .from("marketplace_listings")
      .select(LISTINGS_SELECT_WITH_ACCOUNT)
      .eq("user_id", user.id)
      .order("api_last_seen_at", { ascending: false }));

    if (error) {
      const errMsg = String(error?.message ?? "").toLowerCase();
      if (errMsg.includes("marketplace_accounts") || String(error?.code ?? "") === "PGRST200") {
        console.warn("[Suse7][API][ml-listings] account_join_fallback", {
          message: error?.message,
          code: error?.code,
        });
        ({ data, error } = await supabase
          .from("marketplace_listings")
          .select(LISTINGS_SELECT_BASE)
          .eq("user_id", user.id)
          .order("api_last_seen_at", { ascending: false }));
      }
    }

    if (error) {
      console.error("[Suse7][API][ml-listings] failed", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return res.status(200).json({
        ok: true,
        listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
        pricing_protocol: "suse7-pricing-v1",
        listings: [],
        items: [],
        page: 1,
        page_size: 50,
        total: 0,
      });
    }

    const listings = (data ?? []).map((row) => {
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
    const accountById = await loadMarketplaceAccountMetaMap(supabase, user.id);

    for (const listing of listings) {
      const accountId =
        listing.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
          ? String(listing.marketplace_account_id).trim()
          : "";
      if (!accountId) continue;
      listing.joined_account_alias = resolveMarketplaceAccountDisplayNameById(accountId, accountById);
    }

    const listingIds = listings.map((l) => l.id).filter(Boolean);

    const healthLoad = await fetchAllListingHealthRowsCompat(supabase, user.id);
    const healthRows = healthLoad.data;
    if (healthRows == null) {
      console.error("[Suse7][API][ml-listings] failed", {
        message: healthLoad.error?.message ?? "health query failed",
        code: healthLoad.error?.code,
        details: healthLoad.error?.details,
      });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const healthByKey = new Map();
    for (const h of healthRows || []) {
      putListingGridRowAliases(healthByKey, h.marketplace, h, (r) => r.external_listing_id);
    }

    /** @type {Map<string, Array<{ secure_url?: unknown; url?: unknown; position?: unknown; raw_json?: unknown }>>} */
    const pictureRowsByListingId = new Map();
    if (listingIds.length > 0) {
      const { data: picRows, error: picErr } = await supabase
        .from("marketplace_listing_pictures")
        .select("listing_id, secure_url, url, position, raw_json")
        .in("listing_id", listingIds)
        .order("position", { ascending: true });

      if (picErr) {
        console.error("[ml/listings] pictures_query_error", picErr);
      } else {
        for (const p of picRows || []) {
          const lid = p.listing_id;
          if (lid == null || lid === "") continue;
          const key = String(lid);
          if (!pictureRowsByListingId.has(key)) pictureRowsByListingId.set(key, []);
          pictureRowsByListingId.get(key)?.push(p);
        }
      }
    }

    const { data: metricsRows, error: metErr } = await supabase
      .from("listing_sales_metrics")
      .select(
        "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, commission_amount_total, shipping_share_total, orders_count, last_sale_at"
      )
      .eq("user_id", user.id);

    if (metErr) {
      console.error("[Suse7][API][ml-listings] failed", {
        message: metErr?.message,
        code: metErr?.code,
        details: metErr?.details,
      });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const metricsByKey = new Map();
    for (const m of metricsRows || []) {
      putListingGridRowAliases(metricsByKey, m.marketplace, m, (r) => r.external_listing_id);
    }

    const { data: profileTaxRow } = await supabase
      .from("profiles")
      .select("imposto_percentual")
      .eq("id", user.id)
      .maybeSingle();
    const sellerTaxPct =
      profileTaxRow?.imposto_percentual != null && String(profileTaxRow.imposto_percentual).trim() !== ""
        ? String(profileTaxRow.imposto_percentual).trim()
        : null;

    const gridRows = listings.map((l) => {
      const met = getListingGridRow(metricsByKey, l.marketplace, l.external_listing_id);
      const hlth = getListingGridRow(healthByKey, l.marketplace, l.external_listing_id);
      const pictureRows =
        l.id != null && l.id !== "" ? pictureRowsByListingId.get(String(l.id)) ?? [] : [];
      /** @type {{ product_cover_url?: string | null }} */
      const lx = l;
      const cover_thumbnail_url = resolveMercadoLibreListingCoverImageUrl({
        listing: /** @type {Record<string, unknown>} */ (l),
        pictureRows,
        productMainImageUrl: lx.product_cover_url ?? null,
      });
      /** @type {Record<string, unknown>} */
      const row = /** @type {Record<string, unknown>} */ (
        buildListingGridRow(String(l.marketplace), l, met, hlth, cover_thumbnail_url, { sellerTaxPct })
      );
      const gallery = resolveGalleryImageUrlsForListing(pictureRows, l.raw_json, 12);
      /** Se o resolver não devolveu HTTP válido mas a galeria tem URL, usa a 1ª (mesma ordem da capa). */
      if (
        (row.cover_thumbnail_url == null || String(row.cover_thumbnail_url).trim() === "") &&
        gallery.urls.length > 0
      ) {
        row.cover_thumbnail_url = gallery.urls[0];
        row.cover_image_url = gallery.urls[0];
      }
      row.gallery_image_urls = gallery.urls;
      row.gallery_image_source = gallery.source;
      const norm = normalizeMercadoLibreExternalListingId(l.external_listing_id);
      if (LISTING_COVER_INLINE_TRACE_IDS.has(norm)) {
        row._listing_cover_trace = buildListingCoverInlineTrace(
          /** @type {Record<string, unknown>} */ (l),
          lx.product_cover_url ?? null,
          row.cover_thumbnail_url ?? cover_thumbnail_url,
          pictureRows
        );
      }
      const accountId =
        l.marketplace_account_id != null && String(l.marketplace_account_id).trim() !== ""
          ? String(l.marketplace_account_id).trim()
          : null;
      const aliasResolved =
        accountId != null
          ? resolveMarketplaceAccountDisplayNameById(accountId, accountById)
          : (/** @type {{ joined_account_alias?: string | null }} */ (lx)).joined_account_alias ??
            null;
      const accountMeta =
        accountId != null
          ? accountById.get(String(accountId).trim().toLowerCase())
          : null;
      row.marketplace_account_id = accountId;
      row.account_alias = aliasResolved;
      row.ml_account_alias = aliasResolved;
      if (accountMeta?.logoUrl != null) {
        row.account_logo_url = accountMeta.logoUrl;
      }
      Object.assign(row, projectSkuDependencyPending(l));
      return row;
    });

    let orderItemsMaps = null;
    try {
      orderItemsMaps = await buildHistoricalCardOrderItemsAggregates(
        supabase,
        user.id,
        /** @type {Record<string, unknown>[]} */ (listings),
        accountById
      );
    } catch (orderItemsErr) {
      console.warn("[Suse7][API][ml-listings] product_card_order_items_aggregate_failed", {
        message: orderItemsErr?.message ?? String(orderItemsErr),
      });
    }

    const localOnly =
      req.query?.local_only === "1" ||
      req.query?.local_only === "true" ||
      String(req.query?.local_only ?? "")
        .trim()
        .toLowerCase() === "true";

    const recalcExternalListingIds =
      req.query?.pricing_recalc_external_id ??
      req.query?.pricing_recalc_external_ids ??
      null;

    if (!localOnly) {
      await maybeEnrichGridRowsWithLiveListingPrices({
        userId: user.id,
        listings: /** @type {Record<string, unknown>[]} */ (listings),
        gridRows: /** @type {Record<string, unknown>[]} */ (gridRows),
        healthByKey,
        metricsByKey,
        sellerTaxPct,
      });
    }

    try {
      enrichListingGridRowsWithProductCardMetrics(/** @type {Record<string, unknown>[]} */ (gridRows), {
        orderItemsMaps,
        metricsByKey,
        accountById,
        listings: /** @type {Record<string, unknown>[]} */ (listings),
      });
    } catch (cardMetricsErr) {
      console.warn("[Suse7][API][ml-listings] product_card_metrics_enrich_failed", {
        message: cardMetricsErr?.message ?? String(cardMetricsErr),
      });
    }

    try {
      await applyListsCurrentPriceStalenessHotfix({
        userId: user.id,
        gridRows: /** @type {Record<string, unknown>[]} */ (gridRows),
        listings: /** @type {Record<string, unknown>[]} */ (listings),
        healthByKey,
        getHealth: (marketplace, externalListingId) =>
          getListingGridRow(healthByKey, marketplace, externalListingId),
      });
    } catch (priceHotfixErr) {
      const err = priceHotfixErr instanceof Error ? priceHotfixErr : new Error(String(priceHotfixErr));
      console.warn("[S7_LISTS_CURRENT_PRICE_R68_AUDIT]", {
        route: "/api/ml/listings",
        error_name: err.name,
        error_message: err.message,
        fallback_used: false,
        selection_reason: "price_hotfix_outer_failed_list_continues",
      });
    }

    try {
      await enrichListingGridRowsWithCompetitionMetrics(
        supabase,
        user.id,
        /** @type {Record<string, unknown>[]} */ (gridRows),
      );
    } catch (competitionEnrichErr) {
      const err =
        competitionEnrichErr instanceof Error
          ? competitionEnrichErr
          : new Error(String(competitionEnrichErr));
      console.warn("[S7_COMPETITION_METRICS_ENRICH_GUARD]", {
        route: "/api/ml/listings",
        error_name: err.name,
        error_message: err.message,
        duration_ms: null,
        fallback_applied: true,
        stage: "listingsList_outer_catch",
      });
      applyCompetitionMetricsFallbackToAllGridRows(
        /** @type {Record<string, unknown>[]} */ (gridRows),
        "unavailable",
      );
    }

    /** Estado atual/projetado unitário — engine PI (paridade Modal) antes do overlay histórico executive. */
    try {
      await enrichListingGridRowsPricingCurrentStateProjectedUnit(
        supabase,
        user.id,
        /** @type {Record<string, unknown>[]} */ (gridRows),
        /** @type {Record<string, unknown>[]} */ (listings),
        healthByKey,
        { localOnly, recalcExternalListingIds },
      );
    } catch (pricingEngineEnrichErr) {
      logPricingListLoadFatal({
        route: "/api/ml/listings",
        localOnly,
        userId: user.id,
        err: pricingEngineEnrichErr,
        stage: "pricing_engine_enrich_outer",
      });
      console.warn("[Suse7][API][ml-listings] pricing_current_state_engine_enrich_failed", {
        message: pricingEngineEnrichErr?.message ?? String(pricingEngineEnrichErr),
      });
      for (let pcsIdx = 0; pcsIdx < gridRows.length; pcsIdx++) {
        const pcsRow = /** @type {Record<string, unknown>} */ (gridRows[pcsIdx]);
        try {
          pcsRow.pricing_current_state = buildPricingCurrentStateReadModelMissGridFallbackContract(pcsRow);
        } catch {
          pcsRow.pricing_current_state = {
            contract_kind: "pricing_current_state_projected_unit",
            missing_data_flags: ["pricing_engine_error"],
            pricing_engine_error: "pricing_engine_outer_fallback",
          };
        }
      }
    }

    const executiveListingMetricsById = new Map();
    try {
      const officialMetrics = await buildOfficialListingMetricsMap(
        supabase,
        user.id,
        /** @type {Record<string, unknown>[]} */ (listings)
      );
      for (const metric of officialMetrics.values()) {
        putExecutiveListingMetric(executiveListingMetricsById, metric);
      }
    } catch (executiveMetricsErr) {
      console.warn("[Suse7][API][ml-listings] executive_listing_metrics_enrich_failed", {
        message: executiveMetricsErr?.message ?? String(executiveMetricsErr),
      });
    }

    for (const row of gridRows) {
      const externalListingId =
        row.external_listing_id != null && String(row.external_listing_id).trim() !== ""
          ? String(row.external_listing_id).trim()
          : "";
      const metric =
        executiveListingMetricsById.get(externalListingId) ??
        executiveListingMetricsById.get(normalizeMercadoLibreExternalListingId(externalListingId));
      exposeOfficialListingFinancialMetrics(row, metric);
    }

    try {
      logHistoricalCardMetricsProbe(
        /** @type {Record<string, unknown>[]} */ (gridRows),
        /** @type {Record<string, unknown>[]} */ (listings),
        orderItemsMaps
      );
    } catch (probeErr) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[Suse7][API][ml-listings] product_card_metrics_probe_failed", {
          message: probeErr?.message ?? String(probeErr),
        });
      }
    }

    for (let i = 0; i < gridRows.length; i++) {
      gridRows[i] = ensureListingGridMoneyContract(/** @type {Record<string, unknown>} */ (gridRows[i]));
      const pcs = /** @type {Record<string, unknown>} */ (gridRows[i]).pricing_current_state;
      if (pcs == null || typeof pcs !== "object") {
        /** @type {Record<string, unknown>} */ (gridRows[i]).pricing_current_state =
          buildPricingCurrentStateReadModelMissGridFallbackContract(
            /** @type {Record<string, unknown>} */ (gridRows[i]),
          );
      }
    }

    await finalizeListingGridAccountFields(
      supabase,
      user.id,
      /** @type {Record<string, unknown>[]} */ (gridRows),
      /** @type {Record<string, unknown>[]} */ (listings),
      accountById,
      orderItemsMaps
    );

    const listingsOut = /** @type {Record<string, unknown>[]} */ (gridRows);

    if (mlPriceValidateLogsEnabled() && listingsOut.length > 0) {
      const cap = Math.min(5, listingsOut.length);
      console.info("[ML_PRICE_VALIDATE][listings_payload_prices]", {
        sample_count: cap,
        rows: listingsOut.slice(0, cap).map((r) => ({
          external_listing_id: r.external_listing_id ?? null,
          price_brl: r.price_brl ?? null,
          list_or_original_price_brl: r.list_or_original_price_brl ?? null,
          promotional_price_brl: r.promotional_price_brl ?? null,
        })),
      });
    }

    const debugExt = String(process.env.ML_LISTINGS_GRID_DEBUG_EXT_ID ?? "4473596489").trim();
    const debugOn =
      process.env.ML_LISTINGS_GRID_DEBUG === "1" ||
      (debugExt !== "" &&
        listingsOut.some((r) => String(r.external_listing_id ?? "").includes(debugExt)));
    if (debugOn) {
      const probeIdx = listings.findIndex((row) =>
        String(row.external_listing_id ?? "").includes(debugExt)
      );
      const probeListing = probeIdx >= 0 ? /** @type {Record<string, unknown>} */ (listings[probeIdx]) : null;
      const probeHealth =
        probeListing != null
          ? getListingGridRow(
              healthByKey,
              probeListing.marketplace,
              probeListing.external_listing_id
            )
          : null;
      const moneyDiag =
        probeListing != null
          ? mercadoLivreMoneyShapeDiagnostics(
              probeListing,
              /** @type {Record<string, unknown> | null | undefined} */ (probeHealth)
            )
          : null;
      const probe = listingsOut.find((r) => String(r.external_listing_id ?? "").includes(debugExt));
      if (probe) {
        const np = /** @type {Record<string, unknown> | null} */ (
          probe.net_proceeds && typeof probe.net_proceeds === "object" ? probe.net_proceeds : null
        );
        console.info("[ML_LISTINGS_GRID_ROW_PRE_RESPONSE]", {
          listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
          external_listing_id: probe.external_listing_id,
          health_raw_json_loaded: Boolean(
            probeHealth &&
              typeof probeHealth === "object" &&
              "raw_json" in probeHealth &&
              probeHealth.raw_json != null
          ),
          ...moneyDiag,
          net_proceeds: probe.net_proceeds,
          insufficient_reason_final: np?.insufficient_reason ?? null,
          source_final: np?.source ?? null,
          net_proceeds_amount_final: np?.net_proceeds_amount ?? null,
          pricing_context: probe.pricing_context,
          net_receive_brl: probe.net_receive_brl,
          gross_revenue_brl: probe.gross_revenue_brl,
          legacy_imported_orders_metrics: probe.legacy_imported_orders_metrics,
        });
      } else if (process.env.ML_LISTINGS_GRID_DEBUG === "1") {
        console.info("[ML_LISTINGS_GRID_ROW_PRE_RESPONSE]", {
          listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
          note: `nenhuma linha com external_listing_id contendo ${debugExt}`,
          total: listingsOut.length,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
      /** Contrato explícito de preço/repasse — ver `docs/SUSE7_PRICING_PROTOCOL_V1.md`. */
      pricing_protocol: "suse7-pricing-v1",
      /**
       * Pricing: `listing_price_brl`, `promotion_active`, `promotional_price_brl`, `effective_sale_price_brl`.
       * Payout: `marketplace_payout_amount` + `marketplace_payout_source`. Espelhos: `net_receive_brl`, `price_brl` (legado).
       * Totais importados: `legacy_imported_orders_metrics` / gross_* (agregado, não unitário).
       */
      listings: listingsOut,
      items: listingsOut,
      page: 1,
      page_size: 50,
      total: listingsOut.length,
    });
  } catch (err) {
    console.error("[Suse7][API][ml-listings] failed", {
      message: err?.message,
      code: err?.code,
      details: err?.details,
    });
    return res.status(200).json({
      ok: true,
      listing_grid_contract_version: LISTING_GRID_MONEY_CONTRACT_VERSION,
      pricing_protocol: "suse7-pricing-v1",
      listings: [],
      items: [],
      page: 1,
      page_size: 50,
      total: 0,
    });
  }
}
