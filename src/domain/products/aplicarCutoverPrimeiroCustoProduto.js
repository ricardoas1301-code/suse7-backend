// ======================================================================
// CPJ-0001 S1.06 — primeiro custo do produto fecha passado financeiramente pendente.
// Elegibilidade: item daquele produto SEM product_cost_snapshot com valor congelado
// (independente de status comercial entregue/pago/encerrado).
// Alterações posteriores de custo = future-only (não reescreve snapshots com valor).
//
// Schema real de sales_order_items (DEV): NÃO possui product_id nem listing_id.
// Match canônico: external_listing_id (via marketplace_listings) + sku / sku_snapshot.
// ======================================================================

import Decimal from "decimal.js";
import { normalizeSkuForDbLookup } from "../productCatalogCompleteness.js";

/**
 * @param {unknown} costPrice
 */
function hadPositiveProductCost(costPrice) {
  if (costPrice == null || String(costPrice).trim() === "") return false;
  try {
    const d = new Decimal(String(costPrice).trim().replace(",", "."));
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}

/**
 * Extrai amount decimal positivo do product_cost_snapshot.
 * @param {Record<string, unknown> | null | undefined} financial
 * @returns {Decimal | null}
 */
export function extractFrozenProductCostAmount(financial) {
  const fin = financial && typeof financial === "object" ? financial : null;
  if (!fin) return null;
  const snap = fin.product_cost_snapshot;
  if (!snap || typeof snap !== "object") return null;
  const amount =
    /** @type {Record<string, unknown>} */ (snap).amount_brl ??
    /** @type {Record<string, unknown>} */ (snap).product_cost_brl ??
    /** @type {Record<string, unknown>} */ (snap).unit_cost_brl ??
    null;
  if (amount == null || String(amount).trim() === "") return null;
  try {
    const d = new Decimal(String(amount).trim().replace(",", "."));
    return d.isFinite() && d.gte(0) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Snapshot de custo do produto considerado congelado = possui VALOR monetário.
 * Stub vazio ({ amount_brl: null }) NÃO é congelado — elegível a fill-empty.
 * @param {Record<string, unknown> | null | undefined} financial
 */
export function itemHasFrozenProductCostSnapshot(financial) {
  return extractFrozenProductCostAmount(financial) != null;
}

const ITEM_SELECT =
  "id, raw_json, quantity, external_listing_id, sku_snapshot, sku, user_id";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function loadEligibleSaleItemsForProduct(supabase, userId, productId) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();

  const { data: productRow, error: productErr } = await supabase
    .from("products")
    .select("id, sku, normalized_sku")
    .eq("id", productId)
    .eq("user_id", userId)
    .maybeSingle();

  if (productErr) throw productErr;

  const { data: listings, error: listErr } = await supabase
    .from("marketplace_listings")
    .select("id, external_listing_id, seller_sku")
    .eq("user_id", userId)
    .eq("product_id", productId)
    .limit(5000);

  if (listErr) throw listErr;

  const externalListingIds = (listings || [])
    .map((r) => (r.external_listing_id != null ? String(r.external_listing_id).trim() : ""))
    .filter(Boolean);

  /** @param {string[]} ids */
  async function addByExternalListingIds(ids) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      if (!chunk.length) continue;
      const { data, error } = await supabase
        .from("sales_order_items")
        .select(ITEM_SELECT)
        .eq("user_id", userId)
        .in("external_listing_id", chunk)
        .limit(5000);
      if (error) throw error;
      for (const row of data || []) {
        if (row?.id) byId.set(String(row.id), row);
      }
    }
  }

  if (externalListingIds.length) {
    await addByExternalListingIds(externalListingIds);
  }

  const skuLiterals = new Set();
  if (productRow?.sku != null && String(productRow.sku).trim() !== "") {
    skuLiterals.add(String(productRow.sku).trim());
  }
  if (productRow?.normalized_sku != null && String(productRow.normalized_sku).trim() !== "") {
    skuLiterals.add(String(productRow.normalized_sku).trim());
  }
  for (const lit of skuLiterals) {
    const nk = normalizeSkuForDbLookup(lit);
    if (nk) skuLiterals.add(nk);
  }
  for (const l of listings || []) {
    if (l?.seller_sku != null && String(l.seller_sku).trim() !== "") {
      skuLiterals.add(String(l.seller_sku).trim());
    }
  }

  for (const sku of skuLiterals) {
    const { data: bySnap, error: snapErr } = await supabase
      .from("sales_order_items")
      .select(ITEM_SELECT)
      .eq("user_id", userId)
      .eq("sku_snapshot", sku)
      .limit(5000);
    if (snapErr) throw snapErr;
    for (const row of bySnap || []) {
      if (row?.id) byId.set(String(row.id), row);
    }

    const { data: bySkuCol, error: skuErr } = await supabase
      .from("sales_order_items")
      .select(ITEM_SELECT)
      .eq("user_id", userId)
      .eq("sku", sku)
      .limit(5000);
    if (skuErr) throw skuErr;
    for (const row of bySkuCol || []) {
      if (row?.id) byId.set(String(row.id), row);
    }
  }

  return [...byId.values()];
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   userId: string;
 *   productId: string;
 *   costs: { cost_price: string; packaging_cost: string; operational_cost: string };
 *   previousCostPrice: unknown;
 * }} params
 */
export async function aplicarCutoverPrimeiroCustoProdutoEmVendasPendentes({
  supabase,
  userId,
  productId,
  costs,
  previousCostPrice,
}) {
  const pid = String(productId || "").trim();
  const uid = String(userId || "").trim();
  if (!pid || !uid) return { ok: false, skipped: true, reason: "invalid_ids" };

  const isFirstCost = !hadPositiveProductCost(previousCostPrice) && hadPositiveProductCost(costs?.cost_price);
  if (!hadPositiveProductCost(costs?.cost_price)) {
    return { ok: true, skipped: true, reason: "no_positive_product_cost", future_only: true };
  }

  let sameCostAsBefore = false;
  if (hadPositiveProductCost(previousCostPrice)) {
    try {
      sameCostAsBefore = new Decimal(String(previousCostPrice).trim().replace(",", ".")).eq(
        new Decimal(String(costs.cost_price).trim().replace(",", ".")),
      );
    } catch {
      sameCostAsBefore = false;
    }
  }

  // Primeiro custo OU re-save do mesmo valor (reparo de cutover incompleto / stub vazio).
  if (!isFirstCost && !sameCostAsBefore) {
    return { ok: true, skipped: true, reason: "not_first_cost", future_only: true };
  }

  let items;
  try {
    items = await loadEligibleSaleItemsForProduct(supabase, uid, pid);
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message) : String(e) };
  }

  if (!items.length) {
    return {
      ok: true,
      skipped: true,
      reason: "no_sale_items",
      backfilled: 0,
      is_first_cost: isFirstCost,
    };
  }

  const result = await backfillItems(supabase, uid, items, costs);
  return {
    ...result,
    is_first_cost: isFirstCost,
    repair_same_cost: sameCostAsBefore && !isFirstCost,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} items
 * @param {{ cost_price: string; packaging_cost: string; operational_cost: string }} costs
 */
async function backfillItems(supabase, userId, items, costs) {
  let backfilled = 0;
  let skippedFrozen = 0;

  for (const row of items) {
    const raw =
      row.raw_json && typeof row.raw_json === "object"
        ? /** @type {Record<string, unknown>} */ (row.raw_json)
        : {};
    const finFromRaw =
      raw._s7_financial && typeof raw._s7_financial === "object"
        ? /** @type {Record<string, unknown>} */ (raw._s7_financial)
        : null;
    const fin = finFromRaw;

    if (itemHasFrozenProductCostSnapshot(fin)) {
      skippedFrozen += 1;
      continue;
    }

    const unit = new Decimal(String(costs.cost_price));
    const qty = new Decimal(
      row.quantity != null && String(row.quantity).trim() !== "" ? String(row.quantity) : "1",
    );
    const amount = unit.mul(qty.isFinite() && qty.gt(0) ? qty : 1).toFixed(2);
    const nowIso = new Date().toISOString();

    const productCostSnapshot = {
      amount_brl: amount,
      product_cost_brl: amount,
      unit_cost_brl: unit.toFixed(2),
      packaging_cost_brl: costs.packaging_cost,
      operational_cost_insumo_brl: costs.operational_cost,
      source: "first_product_cost_cutover_s1_06",
      captured_at: nowIso,
    };

    const existingInternal =
      fin?.internal_costs_snapshot && typeof fin.internal_costs_snapshot === "object"
        ? /** @type {Record<string, unknown>} */ (fin.internal_costs_snapshot)
        : null;

    const nextInternal = {
      ...(existingInternal || {}),
      product_cost_brl: amount,
      packaging_cost_brl: existingInternal?.packaging_cost_brl ?? costs.packaging_cost ?? null,
      operation_cost_brl: existingInternal?.operation_cost_brl ?? costs.operational_cost ?? null,
      source: {
        ...(existingInternal?.source && typeof existingInternal.source === "object"
          ? /** @type {Record<string, unknown>} */ (existingInternal.source)
          : {}),
        product_cost: "first_product_cost_cutover_s1_06",
      },
      snapshot_version: existingInternal?.snapshot_version ?? "s7_internal_costs_v1",
      confidence: existingInternal?.confidence ?? "persisted",
      snapshot_quality: existingInternal?.snapshot_quality ?? "historical",
    };

    const nextFin = {
      ...(fin && typeof fin === "object" ? fin : {}),
      product_cost_snapshot: productCostSnapshot,
      internal_costs_snapshot: nextInternal,
      snapshot_created_at: fin?.snapshot_created_at ?? nowIso,
      captured_at: fin?.captured_at ?? nowIso,
      cutover_first_product_cost_at: nowIso,
    };

    const nextRaw = {
      ...raw,
      _s7_financial: nextFin,
    };

    const { error } = await supabase
      .from("sales_order_items")
      .update({
        raw_json: nextRaw,
        updated_at: nowIso,
      })
      .eq("id", String(row.id))
      .eq("user_id", userId);

    if (!error) backfilled += 1;
  }

  console.info("[S7_PRODUCT_COST_CUTOVER]", {
    user_id: userId,
    backfilled,
    skipped_frozen: skippedFrozen,
    scanned: items.length,
  });

  return {
    ok: true,
    skipped: false,
    reason: "first_cost_cutover",
    backfilled,
    skipped_frozen: skippedFrozen,
  };
}
