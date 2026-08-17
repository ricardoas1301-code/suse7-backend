// =============================================================================
// Clientes 360 — agregados determinísticos a partir de sales_orders (read path B)
// =============================================================================

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

/**
 * @param {unknown} orderRaw
 */
export function buyerExternalIdFromOrderRaw(orderRaw) {
  const raw = orderRaw && typeof orderRaw === "object" ? orderRaw : {};
  const buyer = raw.buyer && typeof raw.buyer === "object" ? raw.buyer : {};
  return safeStr(buyer.id);
}

/**
 * @param {{
 *   marketplace: string | null | undefined;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 *   externalCustomerId: string | null | undefined;
 * }} p
 */
export function customerAggregateKey(p) {
  const mp = safeStr(p.marketplace) ?? "";
  const acc = safeStr(p.marketplaceAccountId) ?? "";
  const co = safeStr(p.sellerCompanyId) ?? "";
  const ext = safeStr(p.externalCustomerId) ?? "";
  if (!ext) return null;
  return `${mp}|${acc}|${co}|${ext}`;
}

/**
 * @returns {{
 *   total_orders: number;
 *   total_spent: number;
 *   first_purchase_at: string | null;
 *   last_purchase_at: string | null;
 * }}
 */
export function emptyAggregate() {
  return {
    total_orders: 0,
    total_spent: 0,
    first_purchase_at: null,
    last_purchase_at: null,
  };
}

/**
 * @param {ReturnType<typeof emptyAggregate>} agg
 * @param {{ orderDate: string | null; orderTotal: number }} order
 */
function bumpAggregate(agg, order) {
  agg.total_orders += 1;
  agg.total_spent = Math.round((agg.total_spent + order.orderTotal) * 100) / 100;
  const d = order.orderDate;
  if (d) {
    if (!agg.first_purchase_at || d < agg.first_purchase_at) agg.first_purchase_at = d;
    if (!agg.last_purchase_at || d > agg.last_purchase_at) agg.last_purchase_at = d;
  }
}

/**
 * @param {unknown} amount
 */
function orderTotalNum(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 *   externalCustomerIds?: string[] | null;
 *   limit?: number;
 * }} scope
 * @returns {Promise<Map<string, ReturnType<typeof emptyAggregate>>>}
 */
export async function computeAggregatesForScope(supabase, scope) {
  /** @type {Map<string, ReturnType<typeof emptyAggregate>>} */
  const map = new Map();
  const userId = scope.userId;
  const limit = Number.isFinite(scope.limit) && scope.limit > 0 ? Math.min(scope.limit, 20000) : 10000;

  let q = supabase
    .from("sales_orders")
    .select(
      "id, marketplace, marketplace_account_id, seller_company_id, raw_json, date_created_marketplace, total_amount",
    )
    .eq("user_id", userId)
    .order("date_created_marketplace", { ascending: false })
    .limit(limit);

  const mp = safeStr(scope.marketplace);
  const acc = safeStr(scope.marketplaceAccountId);
  const co = safeStr(scope.sellerCompanyId);
  if (mp) q = q.eq("marketplace", mp);
  if (acc) q = q.eq("marketplace_account_id", acc);
  if (co) q = q.eq("seller_company_id", co);

  const { data: orders, error } = await q;
  if (error) {
    if (isMissingTableOrColumn(error)) return map;
    throw error;
  }

  const idFilter =
    Array.isArray(scope.externalCustomerIds) && scope.externalCustomerIds.length > 0
      ? new Set(scope.externalCustomerIds.map((x) => safeStr(x)).filter(Boolean))
      : null;

  for (const order of orders ?? []) {
    const externalId = buyerExternalIdFromOrderRaw(order?.raw_json);
    if (!externalId) continue;
    if (idFilter && !idFilter.has(externalId)) continue;

    const key = customerAggregateKey({
      marketplace: order.marketplace,
      marketplaceAccountId: order.marketplace_account_id,
      sellerCompanyId: order.seller_company_id,
      externalCustomerId: externalId,
    });
    if (!key) continue;

    let agg = map.get(key);
    if (!agg) {
      agg = emptyAggregate();
      map.set(key, agg);
    }

    bumpAggregate(agg, {
      orderDate:
        order.date_created_marketplace != null ? String(order.date_created_marketplace) : null,
      orderTotal: orderTotalNum(order.total_amount),
    });
  }

  return map;
}

/**
 * @param {string | null | undefined} iso
 */
export function daysSinceIso(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * @param {number} cents
 */
export function formatBrlAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0.00";
  return (Math.round(n * 100) / 100).toFixed(2);
}
