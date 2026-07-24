// ======================================================================
// SSOT — metering de consumo da assinatura (ecossistema seller).
// Unidade cobrada: sale_order (pedido/venda distinto em sales_orders).
// Agrega todas as contas/marketplaces do tenant — sem marketplace_account_id fixo.
// ======================================================================

/** @typedef {"sale_order"} SubscriptionUsageUnit */

export const SUBSCRIPTION_USAGE_UNIT = /** @type {SubscriptionUsageUnit} */ ("sale_order");
export const SUBSCRIPTION_USAGE_AGGREGATION_SCOPE = "seller_ecosystem";

const BREAKDOWN_PAGE_SIZE = 1000;
const BREAKDOWN_MAX_PAGES = 50;

/**
 * @param {unknown} error
 */
function isMissingRelationError(error) {
  const msg = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "");
  if (code === "42703") return false;
  return (
    code === "42P01" ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

/**
 * @param {{ period_start: string; period_end: string }} window
 */
function buildWindowIsoRange(window) {
  return {
    startIso: `${window.period_start}T00:00:00.000Z`,
    endIso: `${window.period_end}T23:59:59.999Z`,
  };
}

/**
 * Chave de unicidade canônica do pedido — prioriza id interno; fallback externo composto.
 *
 * @param {Record<string, unknown> | null | undefined} order
 */
export function buildSubscriptionOrderIdentityKey(order) {
  const internalId = order?.id != null ? String(order.id).trim() : "";
  if (internalId) return `id:${internalId}`;

  const marketplace = order?.marketplace != null ? String(order.marketplace).trim() : "";
  const accountId = order?.marketplace_account_id != null ? String(order.marketplace_account_id).trim() : "";
  const externalOrderId = order?.external_order_id != null ? String(order.external_order_id).trim() : "";

  if (marketplace && accountId && externalOrderId) {
    return `ext:${marketplace}:${accountId}:${externalOrderId}`;
  }

  return internalId ? `id:${internalId}` : null;
}

/**
 * @param {Record<string, number>} bucket
 * @param {string | null | undefined} key
 */
function incrementBreakdownBucket(bucket, key) {
  if (!key) return;
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/**
 * Agrega um pedido distinto nos breakdowns analíticos.
 *
 * @param {{
 *   marketplaces: Record<string, number>;
 *   companies: Record<string, number>;
 *   accounts: Record<string, number>;
 * }} breakdowns
 * @param {Record<string, unknown>} order
 */
export function aggregateSubscriptionOrderBreakdownRow(breakdowns, order) {
  const marketplace = order?.marketplace != null ? String(order.marketplace).trim() : "";
  const accountId = order?.marketplace_account_id != null ? String(order.marketplace_account_id).trim() : "";
  const companyId = order?.seller_company_id != null ? String(order.seller_company_id).trim() : "";

  incrementBreakdownBucket(breakdowns.marketplaces, marketplace);
  incrementBreakdownBucket(breakdowns.accounts, accountId);
  incrementBreakdownBucket(breakdowns.companies, companyId);
}

/**
 * Contagem canônica — pedidos distintos (sales_orders.id) no ciclo.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ period_start: string; period_end: string }} window
 */
export async function countSellerEcosystemSalesUsage(supabase, userId, window) {
  const { startIso, endIso } = buildWindowIsoRange(window);
  const { count, error } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("date_created_marketplace", startIso)
    .lte("date_created_marketplace", endIso);

  if (error) {
    if (isMissingRelationError(error)) return 0;
    throw error;
  }

  return Math.max(0, Number(count ?? 0));
}

/**
 * Contagem legada por itens — apenas diagnóstico/comparativo.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ period_start: string; period_end: string }} window
 */
export async function countSellerEcosystemSaleItemsUsageLegacy(supabase, userId, window) {
  const { startIso, endIso } = buildWindowIsoRange(window);
  const { count, error } = await supabase
    .from("sales_order_items")
    .select("id, sales_orders!inner(date_created_marketplace)", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("sales_orders.date_created_marketplace", startIso)
    .lte("sales_orders.date_created_marketplace", endIso);

  if (error) {
    if (isMissingRelationError(error)) return 0;
    throw error;
  }

  return Math.max(0, Number(count ?? 0));
}

/**
 * Breakdowns analíticos por marketplace/conta/empresa — um pedido = uma venda.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ period_start: string; period_end: string }} window
 */
export async function buildSellerSalesUsageBreakdowns(supabase, userId, window) {
  const { startIso, endIso } = buildWindowIsoRange(window);
  const marketplaces = /** @type {Record<string, number>} */ ({});
  const companies = /** @type {Record<string, number>} */ ({});
  const accounts = /** @type {Record<string, number>} */ ({});

  for (let page = 0; page < BREAKDOWN_MAX_PAGES; page += 1) {
    const from = page * BREAKDOWN_PAGE_SIZE;
    const to = from + BREAKDOWN_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("sales_orders")
      .select("id, marketplace, marketplace_account_id, seller_company_id, external_order_id")
      .eq("user_id", userId)
      .gte("date_created_marketplace", startIso)
      .lte("date_created_marketplace", endIso)
      .range(from, to);

    if (error) {
      if (isMissingRelationError(error)) {
        return { marketplaces, companies, accounts, truncated: false };
      }
      throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      aggregateSubscriptionOrderBreakdownRow({ marketplaces, companies, accounts }, row);
    }

    if (rows.length < BREAKDOWN_PAGE_SIZE) {
      return { marketplaces, companies, accounts, truncated: false };
    }
  }

  return { marketplaces, companies, accounts, truncated: true };
}
