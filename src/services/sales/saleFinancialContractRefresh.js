import Decimal from "decimal.js";
import {
  buildMercadoLivreMarketplaceFeeContract,
  marketplaceFeeFromFinancialSnapshot,
} from "../../domain/sales/mercadoLivreMarketplaceFee.js";
import {
  resolveEffectiveMercadoLivreSaleLine,
  resolveListingTypeId,
  resolveSaleGrossBrl,
  resolveSaleQuantity,
  resolveSaleUnitPriceBrl,
} from "../../domain/sales/saleDetailMarketplaceRevenue.js";
import { ML_FINANCIAL_SNAPSHOT_VERSION } from "../../domain/sales/mercadoLivreSaleRevenueRules.js";
import { enrichMercadoLivreSaleFinancialSnapshot } from "../marketplace/mercadoLivreSaleFinancialEnrichment.js";

/** @param {unknown} v */
function pickFinSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fin = /** @type {Record<string, unknown>} */ (raw)._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 * @param {Record<string, unknown> | null} listing
 */
export function refreshMercadoLivreItemMarketplaceFeeContract(item, order = null, listing = null) {
  const line = resolveEffectiveMercadoLivreSaleLine(item, order);
  const listingTypeId = resolveListingTypeId(line, listing);
  const { gross } = resolveSaleGrossBrl(item, line);
  const grossStr = gross != null ? gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;
  const qty = resolveSaleQuantity(item, line);
  const unit = resolveSaleUnitPriceBrl(item, line);

  const itemRaw =
    item.raw_json && typeof item.raw_json === "object" ? /** @type {Record<string, unknown>} */ (item.raw_json) : {};
  const existingFin = pickFinSnapshot(itemRaw);

  const marketplaceFeeBefore = marketplaceFeeFromFinancialSnapshot(existingFin);

  const marketplaceFeeAfter =
    grossStr != null
      ? buildMercadoLivreMarketplaceFeeContract({
          sale_price_brl: grossStr,
          listing_type_id: listingTypeId,
          line: line && typeof line === "object" ? line : null,
          listing,
          qty,
          unit_price_brl: unit != null ? unit.toFixed(2) : null,
        })
      : null;

  let netReceived = existingFin?.net_received_amount_brl != null ? String(existingFin.net_received_amount_brl) : null;
  if (grossStr && marketplaceFeeAfter?.amount_brl) {
    let netDec = new Decimal(grossStr).minus(marketplaceFeeAfter.amount_brl);
    const shipRaw = existingFin?.shipping_amount_brl;
    if (shipRaw != null && String(shipRaw).trim() !== "") {
      netDec = netDec.minus(new Decimal(String(shipRaw).replace(",", ".")));
    }
    const adjRaw = existingFin?.positive_adjustments_brl;
    if (adjRaw != null && String(adjRaw).trim() !== "") {
      netDec = netDec.plus(new Decimal(String(adjRaw).replace(",", ".")));
    }
    netReceived = netDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  const mergedFin = {
    ...(existingFin ?? {}),
    snapshot_version: ML_FINANCIAL_SNAPSHOT_VERSION,
    snapshot_complete: existingFin?.snapshot_complete ?? true,
    gross_sale_amount_brl: grossStr ?? existingFin?.gross_sale_amount_brl ?? null,
    marketplace_fee: marketplaceFeeAfter,
    marketplace_fee_amount_brl: marketplaceFeeAfter?.amount_brl ?? null,
    marketplace_fee_percent: marketplaceFeeAfter?.percentage ?? null,
    listing_type_id: listingTypeId,
    listing_type_label: marketplaceFeeAfter?.listing_type_label ?? existingFin?.listing_type_label ?? null,
    net_received_amount_brl: netReceived,
    updated_at: new Date().toISOString(),
  };

  itemRaw._s7_financial = mergedFin;

  console.log("[S7 RAYX FEE REFRESH]", {
    sale_id: item.id ?? null,
    item_id: item.id ?? null,
    listing_type_id: listingTypeId,
    listing_type_label: marketplaceFeeAfter?.listing_type_label ?? null,
    sale_price_brl: grossStr,
    fee_percentage: marketplaceFeeAfter?.percentage ?? null,
    fee_amount_before: marketplaceFeeBefore?.amount_brl ?? existingFin?.marketplace_fee_amount_brl ?? null,
    fee_amount_after: marketplaceFeeAfter?.amount_brl ?? null,
    percent_source: marketplaceFeeAfter?.percent_source ?? null,
  });

  return {
    itemRaw,
    marketplace_fee_before: marketplaceFeeBefore,
    marketplace_fee_after: marketplaceFeeAfter,
    patch: {
      raw_json: itemRaw,
      gross_amount: grossStr ?? item.gross_amount,
      fee_amount: marketplaceFeeAfter?.amount_brl ?? item.fee_amount,
      updated_at: mergedFin.updated_at,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} itemId
 * @param {{ accessToken?: string | null }} [opts]
 */
export async function refreshSaleFinancialContractByItemId(supabase, userId, itemId, opts = {}) {
  const { data: item, error: itemErr } = await supabase
    .from("sales_order_items")
    .select("*")
    .eq("user_id", userId)
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) throw itemErr;
  if (!item) return { ok: false, error: "item_not_found" };

  let order = null;
  if (item.sales_order_id) {
    const { data: ord, error: ordErr } = await supabase
      .from("sales_orders")
      .select("id,order_status,external_order_id,raw_json,marketplace_account_id,marketplace,seller_company_id")
      .eq("user_id", userId)
      .eq("id", item.sales_order_id)
      .maybeSingle();
    if (ordErr) throw ordErr;
    order = ord;
  }

  const marketplace = String(item.marketplace ?? order?.marketplace ?? "").toLowerCase();
  if (marketplace === "mercado_livre" || marketplace === "mercadolivre") {
    const token = opts.accessToken != null ? String(opts.accessToken).trim() : "";
    if (token && order?.id && item.marketplace_account_id) {
      await enrichMercadoLivreSaleFinancialSnapshot(supabase, userId, order.raw_json ?? {}, {
        accessToken: token,
        marketplaceAccountId: String(item.marketplace_account_id),
        salesOrderId: String(order.id),
        logContext: "rayx_fee_refresh",
        force: true,
      });
      const { data: refreshed, error: refErr } = await supabase
        .from("sales_order_items")
        .select("*")
        .eq("user_id", userId)
        .eq("id", itemId)
        .maybeSingle();
      if (refErr) throw refErr;
      const fin = pickFinSnapshot(refreshed?.raw_json);
      return {
        ok: true,
        sale_id: itemId,
        item_id: itemId,
        mode: "full_ml_enrichment",
        marketplace_fee_before: null,
        marketplace_fee_after: marketplaceFeeFromFinancialSnapshot(fin),
      };
    }
  }

  const { patch, marketplace_fee_before, marketplace_fee_after } = refreshMercadoLivreItemMarketplaceFeeContract(
    item,
    order,
    null,
  );

  const { error: upErr } = await supabase.from("sales_order_items").update(patch).eq("user_id", userId).eq("id", itemId);
  if (upErr) throw upErr;

  return {
    ok: true,
    sale_id: itemId,
    item_id: itemId,
    mode: "marketplace_fee_contract_only",
    marketplace_fee_before,
    marketplace_fee_after,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ days?: number; marketplace?: string; limit?: number }} [opts]
 */
export async function refreshRecentSaleFinancialContracts(supabase, userId, opts = {}) {
  const days = Math.max(1, Math.trunc(Number(opts.days ?? 1) || 1));
  const limit = Math.min(500, Math.max(1, Math.trunc(Number(opts.limit ?? 200) || 200)));
  const marketplace = String(opts.marketplace ?? "mercado_livre").trim().toLowerCase();

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("sales_order_items")
    .select("id, marketplace, sales_order_id, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (marketplace) {
    query = query.eq("marketplace", marketplace);
  }

  const { data: rows, error } = await query;
  if (error) throw error;

  /** @type {Array<Record<string, unknown>>} */
  const failures = [];
  let updated = 0;

  for (const row of rows || []) {
    const id = row?.id != null ? String(row.id) : "";
    if (!id) continue;
    try {
      const result = await refreshSaleFinancialContractByItemId(supabase, userId, id);
      if (result.ok) updated += 1;
    } catch (e) {
      failures.push({
        item_id: id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    ok: true,
    processed: (rows || []).length,
    updated,
    failed: failures.length,
    failures,
  };
}
