import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { getValidMLToken } from "../ml/_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import {
  ensureMercadoLivreSaleFinancialEnrichmentForDetail,
  logFinancialSnapshotValidation,
} from "../../services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { buildVendasUiRowsFromOrderItems } from "./list.js";
import { buildSaleDetailFinancialBreakdown } from "./saleDetailFinancial.js";
import { finalizeSaleDetailFinancialWithContingency } from "../../domain/sales/saleDetailContingencyMargin.js";
import { EMPTY_SALE_CONTEXT_METRICS, fetchSaleContextMetrics } from "../../domain/sales/saleDetailContextMetrics.js";
import {
  attachFreshMercadoLivreShipmentSnapshot,
  buildSaleDetailGeneralBlock,
} from "../../domain/sales/saleDetailGeneral.js";
import { enrichMercadoLivreSaleTypeDisplay } from "../../domain/sales/mercadoLivreSaleTypeDisplay.js";

/**
 * @param {Record<string, unknown> | null | undefined} order
 */
function pickDeliveryMeta(order) {
  const raw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  if (!raw) {
    return { delivery_label: null, combine_delivery: false };
  }

  const s7 =
    raw._s7_delivery && typeof raw._s7_delivery === "object"
      ? /** @type {Record<string, unknown>} */ (raw._s7_delivery)
      : null;
  const combine = Boolean(s7?.combine_delivery ?? s7?.combine ?? s7?.is_combine_delivery);
  let delivery_label = null;

  if (s7?.logistics_label != null && String(s7.logistics_label).trim() !== "") {
    delivery_label = String(s7.logistics_label).trim();
  } else if (s7?.logistics_type != null && String(s7.logistics_type).trim() !== "") {
    delivery_label = String(s7.logistics_type).trim();
  } else if (s7?.delivery_mode != null && String(s7.delivery_mode).trim() !== "") {
    delivery_label = String(s7.delivery_mode).trim();
  }

  const shipping =
    raw.shipping && typeof raw.shipping === "object" ? /** @type {Record<string, unknown>} */ (raw.shipping) : null;
  if (!delivery_label && shipping?.logistic_type != null && String(shipping.logistic_type).trim() !== "") {
    delivery_label = String(shipping.logistic_type).trim();
  }

  return { delivery_label, combine_delivery: combine };
}

/**
 * @param {Record<string, unknown>} row
 */
function buildImportStatusLabel(row) {
  if (row.needs_product_completion) return "Produto pendente de vínculo";
  const fin = row.financials && typeof row.financials === "object" ? /** @type {Record<string, unknown>} */ (row.financials) : null;
  if (fin?.net_received == null && fin?.sale_price == null) return "Financeiro parcial";
  return "Importado";
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown> | null} order
 */
function buildSaleInsights(row, order) {
  /** @type {string[]} */
  const out = [];
  const fin = row.financials && typeof row.financials === "object" ? /** @type {Record<string, unknown>} */ (row.financials) : null;
  if (fin?.health === "critical") {
    out.push("Esta venda está com prejuízo após custos e repasse.");
  } else if (fin?.health === "attention") {
    out.push("Margem ou lucro abaixo do ideal — revise custos e precificação.");
  }
  if (row.needs_product_completion) {
    out.push("Vincule o anúncio ao produto para enriquecer custos e precificação.");
  }
  const delivery = pickDeliveryMeta(order);
  if (delivery.combine_delivery) {
    out.push("Pedido marcado para Combine a entrega.");
  }
  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 */
async function resolveListingForSaleDetail(supabase, userId, item, order) {
  const marketplace = item.marketplace != null ? String(item.marketplace).trim() : "";
  const externalListingId =
    item.external_listing_id != null && String(item.external_listing_id).trim() !== ""
      ? String(item.external_listing_id).trim()
      : "";
  if (!marketplace || !externalListingId) return null;

  const accountId =
    item.marketplace_account_id != null && String(item.marketplace_account_id).trim() !== ""
      ? String(item.marketplace_account_id).trim()
      : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
        ? String(order.marketplace_account_id).trim()
        : "";

  const selectWithAcc = "id,marketplace,marketplace_account_id,external_listing_id,listing_type_id,raw_json";
  const selectLegacy = "id,marketplace,external_listing_id,listing_type_id,raw_json";

  for (const sel of [selectWithAcc, selectLegacy]) {
    const withAcc = sel.includes("marketplace_account_id");
    let q = supabase
      .from("marketplace_listings")
      .select(sel)
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("external_listing_id", externalListingId)
      .limit(1);
    if (withAcc && accountId) q = q.eq("marketplace_account_id", accountId);
    const { data, error } = await q.maybeSingle();
    if (error) {
      const msg = String(error.message ?? "").toLowerCase();
      if (msg.includes("column") || String(error.code ?? "") === "42703") continue;
      throw error;
    }
    if (data && typeof data === "object") return /** @type {Record<string, unknown>} */ (data);
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} item
 */
function buildSaleDetailProductBlock(row, item) {
  return {
    title: row.product_display_title ?? item.title_snapshot ?? null,
    marketplace: row.marketplace ?? null,
    listing_id_display: row.listing_id_display ?? null,
    sku_display: row.sku_display ?? null,
    item_id: row.item_id ?? null,
    product_image_url: row.product_image_url ?? null,
    product_thumbnail_url: row.product_thumbnail_url ?? row.product_image_url ?? null,
    listing_thumbnail_url: row.listing_thumbnail_url ?? null,
    product_images: row.product_images ?? null,
    product_image_links: row.product_image_links ?? null,
    raw_json: row.raw_json ?? item.raw_json ?? null,
    order_raw_json: row.order_raw_json ?? null,
    external_order_item_id: row.external_order_item_id ?? null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 */
function resolveInternalCostsSnapshotFromItem(item) {
  const raw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const fin =
    raw?._s7_financial && typeof raw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (raw._s7_financial)
      : null;
  const snap =
    fin?.internal_costs_snapshot && typeof fin.internal_costs_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.internal_costs_snapshot)
      : null;
  if (!snap) return null;
  const hasAnyAmount =
    snap.product_cost_brl != null || snap.internal_tax_brl != null || snap.operation_packaging_cost_brl != null;
  return hasAnyAmount ? snap : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 */
function resolveFinancialSnapshotMetadata(item) {
  const raw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const fin =
    raw?._s7_financial && typeof raw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (raw._s7_financial)
      : null;
  if (!fin) {
    return {
      snapshot_origin: null,
      snapshot_quality: null,
      estimated: null,
    };
  }
  const estimatedRaw = fin.estimated;
  return {
    snapshot_origin: fin.snapshot_origin != null ? String(fin.snapshot_origin) : null,
    snapshot_quality: fin.snapshot_quality != null ? String(fin.snapshot_quality) : null,
    estimated: typeof estimatedRaw === "boolean" ? estimatedRaw : null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {Record<string, unknown> | null | undefined} order
 */
function resolveContingencySnapshot(item, order) {
  const itemRaw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const itemFin =
    itemRaw?._s7_financial && typeof itemRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (itemRaw._s7_financial)
      : null;
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  const orderFin =
    orderRaw?._s7_financial && typeof orderRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (orderRaw._s7_financial)
      : null;

  const snap =
    (itemFin?.contingency_margin_snapshot &&
    typeof itemFin.contingency_margin_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (itemFin.contingency_margin_snapshot)
      : null) ??
    (orderFin?.contingency_margin_snapshot &&
    typeof orderFin.contingency_margin_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (orderFin.contingency_margin_snapshot)
      : null);

  const toLine = (key, label, amount, percent) => {
    if (amount == null || String(amount).trim() === "") return null;
    return {
      key,
      label,
      amount_brl: String(amount),
      percent: percent != null && String(percent).trim() !== "" ? String(percent) : null,
    };
  };

  const lines = [];
  const pushIfMissing = (line) => {
    if (!line) return;
    if (lines.findIndex((it) => String(it.key) === String(line.key)) !== -1) return;
    lines.push(line);
  };

  pushIfMissing(
    toLine(
      "ml_ads",
      "ML Ads",
      snap?.ml_ads_brl ?? snap?.ml_ads_amount_brl,
      snap?.ml_ads_percent,
    ),
  );
  pushIfMissing(
    toLine(
      "safety_reserve",
      "Reserva perdas e devoluções",
      snap?.reserve_brl ?? snap?.safety_reserve_brl ?? snap?.reserve_amount_brl,
      snap?.reserve_percent ?? snap?.safety_reserve_percent,
    ),
  );

  const adsSnap =
    itemFin?.ads_snapshot && typeof itemFin.ads_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (itemFin.ads_snapshot)
      : null;
  pushIfMissing(toLine("ml_ads", "ML Ads", adsSnap?.amount_brl ?? adsSnap?.ml_ads_brl, adsSnap?.percent));

  const operationalSnap =
    itemFin?.operational_cost_snapshot && typeof itemFin.operational_cost_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (itemFin.operational_cost_snapshot)
      : null;
  pushIfMissing(
    toLine(
      "safety_reserve",
      "Reserva perdas e devoluções",
      operationalSnap?.reserve_brl ?? operationalSnap?.operational_costs_brl,
      operationalSnap?.reserve_percent,
    ),
  );

  if (lines.length === 0) return null;
  return {
    lines,
    source: "historical_financial_snapshot",
    snapshot_quality:
      String(snap?.snapshot_quality ?? itemFin?.snapshot_quality ?? "")
        .trim()
        .toLowerCase() === "reconstructed"
        ? "reconstructed"
        : "historical",
  };
}

export default async function handleSalesDetail(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const itemId =
    req.query?.item_id != null && String(req.query.item_id).trim() !== ""
      ? String(req.query.item_id).trim()
      : null;

  if (!itemId) {
    return res.status(400).json({ ok: false, error: "item_id é obrigatório" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(503).json({ ok: false, error: "Configuração indisponível" });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "vendas" })) return;

  try {
    const { data: item, error } = await supabase
      .from("sales_order_items")
      .select("*")
      .eq("user_id", user.id)
      .eq("id", itemId)
      .maybeSingle();

    if (error) {
      console.error("[Suse7][API][sales-detail] item_failed", { message: error?.message, code: error?.code });
      return res.status(500).json({ ok: false, error: "Não foi possível carregar o item." });
    }
    if (!item) {
      return res.status(404).json({ ok: false, error: "Item não encontrado." });
    }

    const [row] = await buildVendasUiRowsFromOrderItems(supabase, user.id, [item]);
    if (!row) {
      return res.status(404).json({ ok: false, error: "Item não encontrado." });
    }

    const orderId = item.sales_order_id != null ? String(item.sales_order_id) : null;

    if (process.env.NODE_ENV !== "production" || process.env.S7_SALES_DETAIL_DEBUG === "1") {
      console.log("[sales/detail] incoming params", {
        saleId: orderId,
        orderId,
        itemId,
      });
      console.log("[sales/detail] sale row", {
        id: item.id ?? null,
        sales_order_id: item.sales_order_id ?? null,
        marketplace: item.marketplace ?? null,
        product_id: row.product_id ?? item.product_id ?? null,
      });
      console.log("[sales/detail] item row", {
        id: item.id ?? null,
        external_listing_id: item.external_listing_id ?? null,
        sku: item.sku ?? null,
        marketplace_account_id: item.marketplace_account_id ?? null,
        seller_company_id: item.seller_company_id ?? null,
      });
      console.log("[sales/detail] listing identifiers", {
        external_listing_id: item.external_listing_id ?? null,
        listing_id_display: row.listing_id_display ?? null,
        marketplace_listing_id: row.marketplace_listing_id ?? null,
        sku: row.sku_display ?? item.sku ?? null,
        product_id: row.product_id ?? null,
        marketplace_account_id: item.marketplace_account_id ?? null,
        seller_company_id: item.seller_company_id ?? null,
      });
    }

    let order = null;
    if (orderId) {
      const { data: ord, error: ordErr } = await supabase
        .from("sales_orders")
        .select("id,order_status,external_order_id,raw_json,marketplace_account_id,marketplace,seller_company_id")
        .eq("user_id", user.id)
        .eq("id", orderId)
        .maybeSingle();
      if (!ordErr && ord) order = ord;
    }

    let itemForFinancial = item;
    let orderForGeneral = order;
    const marketplaceSlug = String(item.marketplace ?? order?.marketplace ?? "").trim().toLowerCase();
    const isMercadoLivre =
      marketplaceSlug === ML_MARKETPLACE_SLUG || marketplaceSlug === "mercadolivre";
    const marketplaceAccountIdForMl =
      item.marketplace_account_id != null
        ? String(item.marketplace_account_id).trim()
        : order?.marketplace_account_id != null
          ? String(order.marketplace_account_id).trim()
          : null;

    if (isMercadoLivre && order) {
      logFinancialSnapshotValidation(item, order);
    }

    /** @type {string | null} */
    let mlAccessToken = null;

    if (isMercadoLivre && order && marketplaceAccountIdForMl) {
      try {
        mlAccessToken = await getValidMLToken(user.id, {
          marketplaceAccountId: marketplaceAccountIdForMl,
        });
        const enriched = await ensureMercadoLivreSaleFinancialEnrichmentForDetail(
          supabase,
          user.id,
          item,
          order,
          mlAccessToken,
        );
        if (enriched.order) order = enriched.order;
        if (enriched.item) itemForFinancial = enriched.item;
        if (enriched.enriched) {
          logFinancialSnapshotValidation(itemForFinancial, order);
        }
      } catch (enrichErr) {
        console.warn("[sales/detail] ml_financial_enrichment_skipped", {
          message: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
          item_id: itemId,
        });
      }

      if (mlAccessToken && order) {
        try {
          orderForGeneral = await attachFreshMercadoLivreShipmentSnapshot(
            order,
            mlAccessToken,
            marketplaceAccountIdForMl,
          );
        } catch (shipErr) {
          console.warn("[sales/detail] shipment_snapshot_refresh_skipped", {
            message: shipErr instanceof Error ? shipErr.message : String(shipErr),
            item_id: itemId,
          });
          orderForGeneral = order;
        }
      } else {
        orderForGeneral = order;
      }
    }

    const persistedInternalCostsSnapshot = resolveInternalCostsSnapshotFromItem(itemForFinancial);
    const snapshotMeta = resolveFinancialSnapshotMetadata(itemForFinancial);
    const listingRow = await resolveListingForSaleDetail(supabase, user.id, item, order);
    const listingInternalId = listingRow?.id != null ? String(listingRow.id) : null;
    let financial = buildSaleDetailFinancialBreakdown(itemForFinancial, null, order, listingRow, {});
    financial = {
      ...financial,
      snapshot_origin: snapshotMeta.snapshot_origin,
      snapshot_quality: snapshotMeta.snapshot_quality,
      estimated: snapshotMeta.estimated,
      internal_costs_snapshot: {
        source: persistedInternalCostsSnapshot ? "historical_financial_snapshot" : "snapshot_missing",
        snapshot_quality: persistedInternalCostsSnapshot ? "historical" : "missing",
        estimated: !persistedInternalCostsSnapshot,
      },
    };

    const contingencySnapshot = resolveContingencySnapshot(itemForFinancial, order);
    if (contingencySnapshot) {
      financial = {
        ...financial,
        commercial_adjustment_lines: contingencySnapshot.lines,
        pricing_variables_source: contingencySnapshot.source,
      };
    } else {
      // Protege verdade histórica: sem snapshot de contingência, não usa configuração viva.
      financial = {
        ...financial,
        commercial_adjustment_lines: [],
        pricing_variables_source: "snapshot_missing_no_live_recalculation",
      };
    }

    financial = finalizeSaleDetailFinancialWithContingency(financial);

    if (process.env.NODE_ENV !== "production" || process.env.S7_SALES_DETAIL_DEBUG === "1") {
      const mr =
        financial.marketplace_revenue && typeof financial.marketplace_revenue === "object"
          ? financial.marketplace_revenue
          : null;
      console.log("[sales/detail] marketplace_revenue_final", mr);
      console.log("[sales/detail] applied_sale_promotion", {
        root: financial.applied_sale_promotion ?? null,
        nested: mr?.applied_sale_promotion ?? null,
      });
      console.log("[sales/detail] financial_breakdown_final", {
        gross_sale_amount_brl: mr?.gross_sale_amount_brl ?? financial.gross_amount ?? financial.sale_price ?? null,
        marketplace_fee_amount_brl:
          mr?.marketplace_fee_amount_brl ?? financial.marketplace_fee_amount ?? financial.commission ?? null,
        marketplace_fee_percent: mr?.marketplace_fee_percent ?? financial.marketplace_fee_percent ?? null,
        shipping_amount_brl: mr?.shipping_amount_brl ?? financial.shipping_cost_amount ?? financial.shipping_cost ?? null,
        positive_adjustments_brl: mr?.positive_adjustments_brl ?? financial.positive_adjustments_brl ?? null,
        net_received_amount_brl:
          mr?.net_received_amount_brl ?? financial.net_received_amount ?? financial.net_received ?? null,
        _sources: mr?._sources ?? null,
      });
      if (mr?._debug) {
        console.log("[sales/detail] marketplace_revenue_source_debug", mr._debug);
      }
    }

    let saleContextMetrics = { ...EMPTY_SALE_CONTEXT_METRICS };
    try {
      saleContextMetrics = await fetchSaleContextMetrics(supabase, user.id, item, order, row, listingInternalId);
    } catch (metricsError) {
      console.warn("[sales/detail] sale_context_metrics_failed", {
        message: metricsError instanceof Error ? metricsError.message : String(metricsError),
      });
    }

    let general = buildSaleDetailGeneralBlock(row, orderForGeneral, itemForFinancial);
    if (isMercadoLivre && mlAccessToken) {
      try {
        general = await enrichMercadoLivreSaleTypeDisplay(general, {
          order: orderForGeneral,
          item: itemForFinancial,
          row,
          accessToken: mlAccessToken,
          marketplaceAccountId: marketplaceAccountIdForMl,
        });
      } catch (saleTypeErr) {
        console.warn("[sales/detail] sale_type_display_enrichment_skipped", {
          message: saleTypeErr instanceof Error ? saleTypeErr.message : String(saleTypeErr),
          item_id: itemId,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      blocks: {
        product: buildSaleDetailProductBlock(row, item),
        general,
        financial_breakdown: financial,
        sale_context_metrics: saleContextMetrics,
        profit_margin: {
          profit_brl: financial.profit_brl ?? null,
          profit_amount: financial.profit_amount ?? null,
          margin_percent: financial.margin_percent ?? null,
          health: financial.health ?? financial.health_status ?? null,
          health_status: financial.health_status ?? financial.health ?? null,
          health_label: financial.health_label ?? financial.result?.health_label ?? null,
          offer_status_semantic: financial.offer_status_semantic ?? financial.result?.offer_status_semantic ?? null,
        },
        pricing_comparison: {
          listing_internal_id: listingInternalId,
          message: listingInternalId
            ? "Abra a Precificação Inteligente para revisar o anúncio desta venda."
            : "Vincule o anúncio ao produto/SKU para abrir a Precificação Inteligente.",
        },
        insights: buildSaleInsights(row, order),
      },
    });
  } catch (e) {
    console.error("[Suse7][API][sales-detail] failed", {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      itemId,
    });
    return res.status(500).json({ ok: false, error: "Erro interno ao carregar detalhe." });
  }
}
