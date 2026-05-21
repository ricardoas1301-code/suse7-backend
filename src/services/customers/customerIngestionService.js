import {
  extractBuyerForGlobalSync,
  touchGlobalCustomerFromOrderContext,
} from "./s7GlobalCustomerSync.js";

function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function pickBuyer(orderRaw) {
  const buyer = orderRaw?.buyer && typeof orderRaw.buyer === "object" ? orderRaw.buyer : {};
  const externalId = safeStr(buyer.id);
  const fn = buyer.first_name != null ? String(buyer.first_name).trim() : "";
  const ln = buyer.last_name != null ? String(buyer.last_name).trim() : "";
  const composed = fn || ln ? `${fn} ${ln}`.trim() : null;
  const full =
    buyer.full_name != null && String(buyer.full_name).trim() !== ""
      ? String(buyer.full_name).trim()
      : orderRaw?.buyer_full_name != null && String(orderRaw.buyer_full_name).trim() !== ""
        ? String(orderRaw.buyer_full_name).trim()
        : null;
  const nick =
    buyer.nickname != null && String(buyer.nickname).trim() !== "" ? String(buyer.nickname).trim() : "";
  const name = full || composed || nick || null;
  const email = safeStr(buyer.email);
  const phone =
    buyer.phone && typeof buyer.phone === "object" && buyer.phone.number != null
      ? safeStr(buyer.phone.number)
      : null;
  return { externalId, name, email, phone };
}

function isUpsertConflictSpecError(error) {
  return String(error?.code ?? "") === "42P10";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} row
 */
async function manualUpsertMarketplaceCustomer(supabase, row) {
  let q = supabase
    .from("marketplace_customers")
    .select("id")
    .eq("user_id", row.user_id)
    .eq("marketplace", row.marketplace)
    .eq("external_customer_id", row.external_customer_id);

  const accountId = safeStr(row.marketplace_account_id);
  if (accountId) q = q.eq("marketplace_account_id", accountId);
  else q = q.is("marketplace_account_id", null);

  const { data: existing, error: selErr } = await q.maybeSingle();
  if (selErr) return { ok: false, error: selErr };

  const patch = {
    name: row.name,
    email: row.email,
    phone: row.phone,
    seller_company_id: row.seller_company_id ?? null,
    raw_json: row.raw_json,
    updated_at: row.updated_at,
  };

  if (existing?.id) {
    const { error } = await supabase.from("marketplace_customers").update(patch).eq("id", existing.id);
    if (error) return { ok: false, error };
    return { ok: true };
  }

  const { error } = await supabase.from("marketplace_customers").insert(row);
  if (error) return { ok: false, error };
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} row
 * @param {{ allowLegacyFallback: boolean }} opts
 */
async function upsertMarketplaceCustomer(supabase, row, opts) {
  const allowLegacyFallback = opts.allowLegacyFallback === true;
  const accountId = safeStr(row.marketplace_account_id);
  const externalId = safeStr(row.external_customer_id);

  /** @type {{ row: Record<string, unknown>; onConflict: string }[]} */
  const variants = [];

  if (accountId && externalId) {
    variants.push({
      row,
      onConflict: "marketplace,marketplace_account_id,external_customer_id",
    });
  }

  if (allowLegacyFallback && externalId) {
    variants.push({
      row: {
        user_id: row.user_id,
        marketplace: row.marketplace,
        external_customer_id: row.external_customer_id,
        seller_company_id: row.seller_company_id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        raw_json: row.raw_json,
        updated_at: row.updated_at,
      },
      onConflict: "user_id,marketplace,external_customer_id",
    });
  }

  for (const v of variants) {
    const { error } = await supabase
      .from("marketplace_customers")
      .upsert(v.row, { onConflict: v.onConflict, ignoreDuplicates: false });
    if (!error) return { ok: true };
    if (isMissingTableOrColumn(error) || isUpsertConflictSpecError(error)) continue;
    return { ok: false, error };
  }

  const manual = await manualUpsertMarketplaceCustomer(supabase, row);
  if (manual.ok) return { ok: true };
  if (isMissingTableOrColumn(manual.error)) {
    return { ok: false, error: { message: "marketplace_customers schema unavailable" } };
  }
  return manual;
}

export async function ingestCustomersFromSales({
  supabase,
  userId,
  marketplace,
  marketplaceAccountId,
  sellerCompanyId,
  saleDateFrom,
}) {
  const out = {
    processedOrders: 0,
    upsertedCustomers: 0,
    createdCustomers: 0,
    updatedCustomers: 0,
    withoutCustomer: 0,
    skippedOrders: 0,
    errors: [],
  };

  const scopedAccountId = safeStr(marketplaceAccountId);
  const scopedSellerCompanyId = safeStr(sellerCompanyId);

  /** @type {Set<string>} */
  const knownExternalIds = new Set();
  if (scopedAccountId) {
    let cq = supabase
      .from("marketplace_customers")
      .select("external_customer_id")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("marketplace_account_id", scopedAccountId)
      .limit(10000);
    if (scopedSellerCompanyId) cq = cq.eq("seller_company_id", scopedSellerCompanyId);

    const { data: existingCustomers, error: ce } = await cq;
    if (ce) {
      if (!isMissingTableOrColumn(ce)) throw ce;
    } else {
      for (const c of existingCustomers ?? []) {
        const ext = safeStr(c.external_customer_id);
        if (ext) knownExternalIds.add(ext);
      }
    }
  }

  const PAGE_SIZE = 1000;
  let legacyNoPendingColumn = false;
  {
    const probe = await supabase.from("sales_orders").select("customer_ingested_at").limit(1);
    if (probe.error && isMissingTableOrColumn(probe.error)) legacyNoPendingColumn = true;
  }

  /**
   * @param {boolean} pendingOnly
   * @param {number} from
   * @param {number} to
   */
  async function fetchOrderBatch(pendingOnly, from, to) {
    let q = supabase
      .from("sales_orders")
      .select(
        "id, raw_json, date_created_marketplace, marketplace_account_id, seller_company_id, total_amount, customer_ingested_at",
      )
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .order("date_created_marketplace", { ascending: false })
      .range(from, to);
    if (scopedAccountId) q = q.eq("marketplace_account_id", scopedAccountId);
    if (scopedSellerCompanyId) q = q.eq("seller_company_id", scopedSellerCompanyId);
    if (saleDateFrom) q = q.gte("date_created_marketplace", String(saleDateFrom));
    if (pendingOnly) q = q.is("customer_ingested_at", null);

    let { data, error } = await q;
    if (error && isMissingTableOrColumn(error)) {
      let qLegacy = supabase
        .from("sales_orders")
        .select(
          "id, raw_json, date_created_marketplace, marketplace_account_id, seller_company_id, total_amount",
        )
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .order("date_created_marketplace", { ascending: false })
        .range(from, to);
      if (scopedAccountId) qLegacy = qLegacy.eq("marketplace_account_id", scopedAccountId);
      if (scopedSellerCompanyId) qLegacy = qLegacy.eq("seller_company_id", scopedSellerCompanyId);
      if (saleDateFrom) qLegacy = qLegacy.gte("date_created_marketplace", String(saleDateFrom));
      const legacy = await qLegacy;
      data = legacy.data;
      error = legacy.error;
    }
    if (error) {
      if (isMissingTableOrColumn(error)) return [];
      throw error;
    }
    return Array.isArray(data) ? data : [];
  }

  while (true) {
    const orders = await fetchOrderBatch(!legacyNoPendingColumn, 0, PAGE_SIZE - 1);
    if (orders.length === 0) break;

    await processOrders(orders);
    if (orders.length < PAGE_SIZE) break;
  }

  return out;

  /**
   * @param {Record<string, unknown>[]} batch
   */
  async function processOrders(batch) {
  for (const order of batch) {
    out.processedOrders += 1;

    if (order?.customer_ingested_at != null && String(order.customer_ingested_at).trim() !== "") {
      out.skippedOrders += 1;
      continue;
    }

    const buyer = pickBuyer(order?.raw_json);
    if (!buyer.externalId) {
      out.withoutCustomer += 1;
      out.skippedOrders += 1;
      continue;
    }

    const orderAccountId = safeStr(order.marketplace_account_id) ?? scopedAccountId;
    const orderSellerCompanyId = safeStr(order.seller_company_id) ?? scopedSellerCompanyId;

    const row = {
      user_id: userId,
      marketplace,
      marketplace_account_id: orderAccountId,
      seller_company_id: orderSellerCompanyId,
      external_customer_id: buyer.externalId,
      name: buyer.name,
      email: buyer.email,
      phone: buyer.phone,
      raw_json: order?.raw_json ?? {},
      updated_at: new Date().toISOString(),
    };

    const up = await upsertMarketplaceCustomer(supabase, row, {
      allowLegacyFallback: !orderAccountId,
    });
    if (!up.ok) {
      out.errors.push(String(up.error?.message ?? "customer_upsert_failed"));
      continue;
    }
    out.upsertedCustomers += 1;
    if (knownExternalIds.has(buyer.externalId)) {
      out.updatedCustomers += 1;
    } else {
      out.createdCustomers += 1;
      knownExternalIds.add(buyer.externalId);
    }

    const buyerPick = extractBuyerForGlobalSync(order?.raw_json);
    await touchGlobalCustomerFromOrderContext(supabase, {
      userId,
      marketplace,
      marketplaceAccountId: orderAccountId,
      sellerCompanyId: orderSellerCompanyId,
      salesOrderId: order.id != null ? String(order.id) : null,
      orderDateIso: order.date_created_marketplace != null ? String(order.date_created_marketplace) : null,
      orderTotal: order.total_amount,
      buyerPick,
      bumpOrderAggregate: true,
    });

    const ingestedAt = new Date().toISOString();
    const { error: markErr } = await supabase
      .from("sales_orders")
      .update({ customer_ingested_at: ingestedAt })
      .eq("id", order.id)
      .eq("user_id", userId);
    if (markErr && !isMissingTableOrColumn(markErr)) {
      out.errors.push(String(markErr.message ?? "customer_ingested_mark_failed"));
    }
  }
  }
}

