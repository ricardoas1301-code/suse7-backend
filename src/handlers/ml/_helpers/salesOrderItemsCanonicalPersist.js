// ======================================================================
// Persistência idempotente de sales_order_items (UPSERT + órfãos + reconciliação).
// ======================================================================

import Decimal from "decimal.js";

/** Tolerância formal para reconciliação header vs linhas (BRL). */
export const SALES_ORDER_ITEMS_RECONCILIATION_TOLERANCE_BRL = new Decimal("0.01");

export const SALES_ORDER_ITEMS_CANONICAL_UPSERT_CONFLICT =
  "marketplace,marketplace_account_id,external_order_id,external_order_item_id";

/**
 * @param {unknown} orderTotalAmount
 * @param {Array<{ gross_amount?: unknown }>} itemRows
 * @param {{ tolerance?: Decimal }} [options]
 */
export function reconcileSalesOrderItemsGrossVsHeader(orderTotalAmount, itemRows, options = {}) {
  const tolerance = options.tolerance ?? SALES_ORDER_ITEMS_RECONCILIATION_TOLERANCE_BRL;
  let sumGross = new Decimal(0);
  for (const row of itemRows ?? []) {
    const raw = row?.gross_amount;
    if (raw == null || String(raw).trim() === "") continue;
    sumGross = sumGross.plus(new Decimal(String(raw).replace(",", ".")));
  }

  if (orderTotalAmount == null || String(orderTotalAmount).trim() === "") {
    return {
      ok: true,
      skipped: true,
      reason: "header_total_missing",
      sum_gross_brl: sumGross.toFixed(2),
      header_total_brl: null,
      delta_brl: null,
    };
  }

  const headerTotal = new Decimal(String(orderTotalAmount).replace(",", "."));
  const delta = sumGross.minus(headerTotal).abs();

  return {
    ok: delta.lte(tolerance),
    skipped: false,
    sum_gross_brl: sumGross.toFixed(2),
    header_total_brl: headerTotal.toFixed(2),
    delta_brl: delta.toFixed(2),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} salesOrderId
 * @param {Record<string, unknown>[]} rows
 * @param {(msg: string, extra?: Record<string, unknown>) => void} [log]
 */
export async function persistSalesOrderItemsCanonicalUpsert(supabase, salesOrderId, rows, log = () => {}) {
  const canonicalRows = (rows ?? []).filter(
    (r) => r?.external_order_item_id != null && String(r.external_order_item_id).trim() !== "",
  );

  if (canonicalRows.length === 0) {
    const { error: delAllErr } = await supabase.from("sales_order_items").delete().eq("sales_order_id", salesOrderId);
    if (delAllErr) {
      log("delete_all_order_items_failed", { salesOrderId, delAllErr });
      throw delAllErr;
    }
    return { upserted: 0, orphans_removed: 0, canonical_ids: [] };
  }

  const { error: upsertErr } = await supabase.from("sales_order_items").upsert(canonicalRows, {
    onConflict: SALES_ORDER_ITEMS_CANONICAL_UPSERT_CONFLICT,
  });
  if (upsertErr) {
    log("upsert_order_items_failed", { salesOrderId, upsertErr });
    throw upsertErr;
  }

  /** @type {Set<string>} */
  const canonicalIds = new Set(
    canonicalRows.map((r) => String(r.external_order_item_id).trim()).filter(Boolean),
  );

  const { data: existing, error: fetchErr } = await supabase
    .from("sales_order_items")
    .select("id, external_order_item_id")
    .eq("sales_order_id", salesOrderId);
  if (fetchErr) {
    log("fetch_order_items_for_orphan_cleanup_failed", { salesOrderId, fetchErr });
    throw fetchErr;
  }

  const orphanIds = (existing ?? [])
    .filter((row) => {
      const eid = row?.external_order_item_id != null ? String(row.external_order_item_id).trim() : "";
      return !eid || !canonicalIds.has(eid);
    })
    .map((row) => String(row.id))
    .filter(Boolean);

  if (orphanIds.length > 0) {
    const { error: delOrphanErr } = await supabase.from("sales_order_items").delete().in("id", orphanIds);
    if (delOrphanErr) {
      log("delete_orphan_order_items_failed", { salesOrderId, delOrphanErr, orphan_count: orphanIds.length });
      throw delOrphanErr;
    }
  }

  return {
    upserted: canonicalRows.length,
    orphans_removed: orphanIds.length,
    canonical_ids: [...canonicalIds],
  };
}

/**
 * @param {{
 *   external_order_id?: string | null;
 *   marketplace_account_id?: string | null;
 *   total_amount?: unknown;
 * }} orderRow
 * @param {import("./salesOrderItemsCanonicalPersist.js").ReturnType<typeof reconcileSalesOrderItemsGrossVsHeader>} reconciliation
 * @param {(msg: string, extra?: Record<string, unknown>) => void} [log]
 */
export function logSalesOrderItemsReconciliationAlert(orderRow, reconciliation, log = () => {}) {
  if (reconciliation.ok || reconciliation.skipped) return;
  log("sales_order_items_reconciliation_mismatch", {
    external_order_id: orderRow.external_order_id ?? null,
    marketplace_account_id: orderRow.marketplace_account_id ?? null,
    sum_gross_brl: reconciliation.sum_gross_brl,
    header_total_brl: reconciliation.header_total_brl,
    delta_brl: reconciliation.delta_brl,
  });
}
