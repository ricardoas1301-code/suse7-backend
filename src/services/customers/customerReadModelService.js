// =============================================================================
// Clientes 360 — read model seller (list, summary, filters, detail)
// =============================================================================

import {
  computeAggregatesForScope,
  customerAggregateKey,
  daysSinceIso,
  emptyAggregate,
  formatBrlAmount,
  buyerExternalIdFromOrderRaw,
} from "./customerOrderAggregateService.js";
import {
  mapCustomerDetailCustomer,
  mapCustomerListRow,
  mapCustomerOrderRow,
} from "./customerPresentationMapper.js";

const CUSTOMER_SCAN_LIMIT = 5000;
const ORDER_HISTORY_DEFAULT = 20;

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

function toPositiveInt(value, fallback, max = 200) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

/**
 * @param {{
 *   total_orders: number;
 *   last_purchase_at: string | null;
 *   email?: string | null;
 *   phone?: string | null;
 *   whatsapp?: string | null;
 *   whatsapp_e164?: string | null;
 * }} p
 */
function inferCustomerStatusMinimal(p) {
  const hasContact = Boolean(
    safeStr(p.email) || safeStr(p.phone) || safeStr(p.whatsapp) || safeStr(p.whatsapp_e164),
  );
  if (!hasContact) return "dados incompletos";

  const orders = Number(p.total_orders) || 0;
  const days = daysSinceIso(p.last_purchase_at);

  if (orders >= 2) return "recorrente";
  if (days != null && days > 90) return "inativo";
  if (orders === 1 && days != null && days <= 30) return "novo";
  if (days != null && days <= 90) return "ativo";
  return null;
}

/**
 * @param {string | null | undefined} period
 * @param {string | null | undefined} lastPurchaseAt
 */
function matchesLastPurchasePeriod(period, lastPurchaseAt) {
  const p = safeStr(period);
  if (!p) return true;
  const days = daysSinceIso(lastPurchaseAt);
  if (days == null) return false;
  const map = { "30d": 30, "60d": 60, "90d": 90, "180d": 180 };
  const maxDays = map[p];
  if (!maxDays) return true;
  return days <= maxDays;
}

/**
 * @param {Record<string, unknown>} query
 */
export function parseCustomersListQuery(query) {
  return {
    q: safeStr(query?.q),
    marketplace: safeStr(query?.marketplace),
    marketplaceAccountId: safeStr(query?.marketplace_account_id),
    sellerCompanyId: safeStr(query?.seller_company_id),
    state: safeStr(query?.state)?.toLowerCase() ?? null,
    city: safeStr(query?.city)?.toLowerCase() ?? null,
    customerStatus: safeStr(query?.customer_status)?.toLowerCase() ?? null,
    lastPurchasePeriod: safeStr(query?.last_purchase_period),
    page: toPositiveInt(query?.page, 1),
    pageSize: toPositiveInt(query?.page_size, 50, 200),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {ReturnType<typeof parseCustomersListQuery>} filters
 */
async function loadMarketplaceCustomerRows(supabase, userId, filters) {
  const selects = [
    "id,user_id,name,email,phone,external_customer_id,marketplace,marketplace_account_id,seller_company_id,updated_at,raw_json,email_is_masked,phone_area_code,phone_number,whatsapp,whatsapp_e164",
    "id,user_id,name,email,phone,external_customer_id,marketplace,marketplace_account_id,seller_company_id,updated_at,raw_json",
  ];

  for (const sel of selects) {
    let q = supabase
      .from("marketplace_customers")
      .select(sel)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(CUSTOMER_SCAN_LIMIT);

    if (filters.marketplace) q = q.eq("marketplace", filters.marketplace);
    if (filters.marketplaceAccountId) q = q.eq("marketplace_account_id", filters.marketplaceAccountId);
    if (filters.sellerCompanyId) q = q.eq("seller_company_id", filters.sellerCompanyId);

    const { data, error } = await q;
    if (error) {
      if (isMissingTableOrColumn(error)) continue;
      throw error;
    }
    return Array.isArray(data) ? data : [];
  }

  return [];
}

/**
 * @param {Record<string, unknown>} row
 * @param {string | null} q
 */
function matchesSearchQuery(row, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    row.name,
    row.document,
    row.email,
    row.phone,
    row.whatsapp,
    row.city,
    row.state,
    row.external_customer_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(needle);
}

/**
 * @param {Array<Record<string, unknown>>} enriched
 * @param {ReturnType<typeof parseCustomersListQuery>} filters
 */
function applyMemoryFilters(enriched, filters) {
  return enriched.filter((row) => {
    if (filters.state && String(row.state ?? "").toLowerCase() !== filters.state) return false;
    if (filters.city && !String(row.city ?? "").toLowerCase().includes(filters.city)) return false;
    if (filters.customerStatus && String(row.customer_status ?? "").toLowerCase() !== filters.customerStatus) {
      return false;
    }
    if (!matchesLastPurchasePeriod(filters.lastPurchasePeriod, row.last_purchase_at)) return false;
    if (!matchesSearchQuery(row, filters.q)) return false;
    return true;
  });
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
function buildFilterFacets(rows) {
  /** @type {Map<string, number>} */
  const marketplaces = new Map();
  /** @type {Map<string, number>} */
  const statuses = new Map();
  /** @type {Map<string, number>} */
  const periods = new Map();
  /** @type {Map<string, number>} */
  const states = new Map();

  for (const r of rows) {
    const mp = safeStr(r.marketplace);
    if (mp) marketplaces.set(mp, (marketplaces.get(mp) ?? 0) + 1);

    const st = safeStr(r.customer_status);
    if (st) statuses.set(st, (statuses.get(st) ?? 0) + 1);

    const state = safeStr(r.state);
    if (state) states.set(state, (states.get(state) ?? 0) + 1);

    for (const [key, maxDays] of [
      ["30d", 30],
      ["60d", 60],
      ["90d", 90],
      ["180d", 180],
    ]) {
      const days = daysSinceIso(r.last_purchase_at);
      if (days != null && days <= maxDays) {
        periods.set(key, (periods.get(key) ?? 0) + 1);
      }
    }
  }

  const mpLabels = { mercado_livre: "Mercado Livre", shopee: "Shopee" };

  return {
    marketplaces: [...marketplaces.entries()].map(([value, count]) => ({
      value,
      label: mpLabels[value] ?? value,
      count,
    })),
    customer_status: [...statuses.entries()].map(([value, count]) => ({ value, count })),
    last_purchase_period: ["30d", "60d", "90d", "180d"].map((value) => ({
      value,
      count: periods.get(value) ?? 0,
    })),
    states: [...states.entries()].map(([value, count]) => ({ value, count })),
  };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
function buildSummaryFromRows(rows) {
  let active = 0;
  let recurring = 0;
  let incomplete = 0;
  let revenue = 0;

  for (const r of rows) {
    const orders = Number(r.total_orders) || 0;
    const spent = Number(r.total_spent_brl) || 0;
    revenue += spent;
    if (orders >= 2) recurring += 1;
    const days = daysSinceIso(r.last_purchase_at);
    if (days != null && days <= 90) active += 1;
    if (String(r.customer_status ?? "").toLowerCase() === "dados incompletos") incomplete += 1;
  }

  const total = rows.length;
  const avgTicket = total > 0 ? revenue / total : 0;

  const top = [...rows]
    .sort((a, b) => Number(b.total_spent_brl) - Number(a.total_spent_brl))
    .slice(0, 10)
    .map((r) => ({
      id: String(r.id),
      name: r.name ?? null,
      total_spent_brl: formatBrlAmount(Number(r.total_spent_brl)),
      total_orders: Number(r.total_orders) || 0,
    }));

  return {
    total_customers: total,
    active_customers: active,
    recurring_customers: recurring,
    incomplete_contact: incomplete,
    total_revenue_brl: formatBrlAmount(revenue),
    average_ticket_brl: formatBrlAmount(avgTicket),
    top_customers: top,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} query
 */
export async function buildCustomersList(supabase, userId, query) {
  const filters = parseCustomersListQuery(query);

  const dbRows = await loadMarketplaceCustomerRows(supabase, userId, filters);
  const externalIds = dbRows.map((r) => safeStr(r.external_customer_id)).filter(Boolean);

  const aggMap = await computeAggregatesForScope(supabase, {
    userId,
    marketplace: filters.marketplace,
    marketplaceAccountId: filters.marketplaceAccountId,
    sellerCompanyId: filters.sellerCompanyId,
    externalCustomerIds: externalIds.length ? externalIds : null,
  });

  /** @type {Array<Record<string, unknown>>} */
  let enriched = dbRows.map((row) => {
    const key = customerAggregateKey({
      marketplace: row.marketplace,
      marketplaceAccountId: row.marketplace_account_id,
      sellerCompanyId: row.seller_company_id,
      externalCustomerId: row.external_customer_id,
    });
    const agg = (key && aggMap.get(key)) || emptyAggregate();
    const mapped = mapCustomerListRow(row, agg);
    mapped.customer_status = inferCustomerStatusMinimal({
      total_orders: mapped.total_orders,
      last_purchase_at: mapped.last_purchase_at,
      email: mapped.email,
      phone: mapped.phone,
      whatsapp: mapped.whatsapp,
      whatsapp_e164: mapped.whatsapp_e164,
    });
    delete mapped._agg;
    delete mapped._pres;
    return mapped;
  });

  const facetBase = enriched;
  enriched = applyMemoryFilters(enriched, filters);

  enriched.sort((a, b) => {
    const ta = a.last_purchase_at ? Date.parse(String(a.last_purchase_at)) : 0;
    const tb = b.last_purchase_at ? Date.parse(String(b.last_purchase_at)) : 0;
    return tb - ta;
  });

  const total = enriched.length;
  const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / filters.pageSize));
  const from = (filters.page - 1) * filters.pageSize;
  const pageRows = enriched.slice(from, from + filters.pageSize);

  return {
    summary: buildSummaryFromRows(enriched),
    filters: {
      ...buildFilterFacets(facetBase),
      applied: {
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.marketplace ? { marketplace: filters.marketplace } : {}),
        ...(filters.marketplaceAccountId ? { marketplace_account_id: filters.marketplaceAccountId } : {}),
        ...(filters.sellerCompanyId ? { seller_company_id: filters.sellerCompanyId } : {}),
        ...(filters.state ? { state: filters.state } : {}),
        ...(filters.city ? { city: filters.city } : {}),
        ...(filters.customerStatus ? { customer_status: filters.customerStatus } : {}),
        ...(filters.lastPurchasePeriod ? { last_purchase_period: filters.lastPurchasePeriod } : {}),
      },
    },
    customers: pageRows,
    pagination: {
      page: filters.page,
      page_size: filters.pageSize,
      total,
      total_pages: totalPages,
    },
    total,
    page: filters.page,
    page_size: filters.pageSize,
  };
}

/**
 * @param {{
 *   total_orders: number;
 *   total_spent_brl: string;
 *   average_ticket_brl: string;
 *   first_purchase_at: string | null;
 *   last_purchase_at: string | null;
 *   days_since_last_purchase: number | null;
 *   customer_status: string | null;
 * }} metrics
 * @param {Record<string, unknown>} customer
 */
export function buildCustomerInsights(metrics, customer) {
  /** @type {string[]} */
  const out = [];
  if ((metrics.total_orders ?? 0) >= 2) {
    out.push("Cliente recorrente identificado.");
  } else {
    out.push("Cliente com primeira compra registrada.");
  }

  const hasContact = Boolean(
    safeStr(customer.email) ||
      safeStr(customer.phone) ||
      safeStr(customer.whatsapp) ||
      safeStr(customer.whatsapp_e164),
  );
  if (!hasContact) {
    out.push("Cliente sem contato completo.");
  } else {
    out.push("Cliente com pelo menos um contato disponível.");
  }

  const days = metrics.days_since_last_purchase;
  if (days != null && days > 90) {
    out.push(`Cliente inativo há ${days} dias.`);
  } else {
    out.push("Cliente com atividade recente.");
  }

  const ticket = Number(metrics.average_ticket_brl);
  if (Number.isFinite(ticket) && ticket >= 200) {
    out.push("Ticket médio relevante para campanhas premium.");
  } else {
    out.push("Ticket médio em faixa padrão.");
  }

  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} customerId
 * @param {Record<string, unknown>} query
 */
export async function buildCustomerDetail(supabase, userId, customerId, query) {
  const selects = [
    "id,user_id,name,email,phone,external_customer_id,marketplace,marketplace_account_id,seller_company_id,updated_at,raw_json,email_is_masked,phone_area_code,phone_number,whatsapp,whatsapp_e164",
    "id,user_id,name,email,phone,external_customer_id,marketplace,marketplace_account_id,seller_company_id,updated_at,raw_json",
  ];

  /** @type {Record<string, unknown> | null} */
  let row = null;
  for (const sel of selects) {
    const { data, error } = await supabase
      .from("marketplace_customers")
      .select(sel)
      .eq("id", customerId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      if (isMissingTableOrColumn(error)) continue;
      throw error;
    }
    row = data;
    break;
  }

  if (!row) return null;

  const aggMap = await computeAggregatesForScope(supabase, {
    userId,
    marketplace: safeStr(row.marketplace),
    marketplaceAccountId: safeStr(row.marketplace_account_id),
    sellerCompanyId: safeStr(row.seller_company_id),
    externalCustomerIds: [safeStr(row.external_customer_id)].filter(Boolean),
  });

  const key = customerAggregateKey({
    marketplace: row.marketplace,
    marketplaceAccountId: row.marketplace_account_id,
    sellerCompanyId: row.seller_company_id,
    externalCustomerId: row.external_customer_id,
  });
  const agg = (key && aggMap.get(key)) || emptyAggregate();

  const ordersPage = toPositiveInt(query?.orders_page, 1);
  const ordersPageSize = toPositiveInt(query?.orders_page_size, ORDER_HISTORY_DEFAULT, 100);

  const orders = await loadCustomerOrders(supabase, userId, row, ordersPageSize * ordersPage);

  const totalSpent = agg.total_spent;
  const totalOrders = agg.total_orders;
  const avgTicket = totalOrders > 0 ? totalSpent / totalOrders : 0;
  const daysSince = daysSinceIso(agg.last_purchase_at);

  const customer = mapCustomerDetailCustomer(row);
  const metrics = {
    total_orders: totalOrders,
    total_spent_brl: formatBrlAmount(totalSpent),
    average_ticket_brl: formatBrlAmount(avgTicket),
    first_purchase_at: agg.first_purchase_at,
    last_purchase_at: agg.last_purchase_at,
    days_since_last_purchase: daysSince,
    customer_status: inferCustomerStatusMinimal({
      total_orders: totalOrders,
      last_purchase_at: agg.last_purchase_at,
      email: customer.email,
      phone: customer.phone,
      whatsapp: customer.whatsapp,
      whatsapp_e164: customer.whatsapp_e164,
    }),
    customer_score: null,
  };

  const from = (ordersPage - 1) * ordersPageSize;
  const pagedOrders = orders.slice(from, from + ordersPageSize);

  return {
    customer,
    metrics,
    orders: pagedOrders,
    insights: buildCustomerInsights(metrics, customer),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} customerRow
 * @param {number} limit
 */
async function loadCustomerOrders(supabase, userId, customerRow, limit) {
  const externalId = safeStr(customerRow.external_customer_id);
  if (!externalId) return [];

  let q = supabase
    .from("sales_orders")
    .select(
      "id,external_order_id,order_status,date_created_marketplace,total_amount,raw_json,marketplace,marketplace_account_id,seller_company_id",
    )
    .eq("user_id", userId)
    .order("date_created_marketplace", { ascending: false })
    .limit(Math.min(limit, 500));

  const mp = safeStr(customerRow.marketplace);
  const acc = safeStr(customerRow.marketplace_account_id);
  const co = safeStr(customerRow.seller_company_id);
  if (mp) q = q.eq("marketplace", mp);
  if (acc) q = q.eq("marketplace_account_id", acc);
  if (co) q = q.eq("seller_company_id", co);

  const { data, error } = await q;
  if (error) {
    if (isMissingTableOrColumn(error)) return [];
    throw error;
  }

  return (data ?? [])
    .filter((order) => buyerExternalIdFromOrderRaw(order.raw_json) === externalId)
    .map((order) => mapCustomerOrderRow(order));
}
