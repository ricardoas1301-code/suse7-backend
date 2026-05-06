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
  const name =
    buyer.nickname != null && String(buyer.nickname).trim() !== ""
      ? String(buyer.nickname).trim()
      : buyer.first_name != null && String(buyer.first_name).trim() !== ""
        ? String(buyer.first_name).trim()
        : null;
  const email = safeStr(buyer.email);
  const phone =
    buyer.phone && typeof buyer.phone === "object" && buyer.phone.number != null
      ? safeStr(buyer.phone.number)
      : null;
  return { externalId, name, email, phone };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} row
 * @param {{ allowLegacyFallback: boolean }} opts
 */
async function upsertMarketplaceCustomer(supabase, row, opts) {
  const allowLegacyFallback = opts.allowLegacyFallback === true;
  const variants = [
    {
      row,
      onConflict: "user_id,marketplace,marketplace_account_id,external_customer_id",
    },
    ...(allowLegacyFallback
      ? [
          {
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
          },
          {
            row: {
              user_id: row.user_id,
              marketplace: row.marketplace,
              external_customer_id: row.external_customer_id,
              name: row.name,
              raw_json: row.raw_json,
              updated_at: row.updated_at,
            },
            onConflict: "user_id,marketplace,external_customer_id",
          },
        ]
      : []),
  ];

  for (const v of variants) {
    const { error } = await supabase
      .from("marketplace_customers")
      .upsert(v.row, { onConflict: v.onConflict, ignoreDuplicates: false });
    if (!error) return { ok: true };
    if (!isMissingTableOrColumn(error)) return { ok: false, error };
  }
  return { ok: false, error: { message: "marketplace_customers schema unavailable" } };
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

  let q = supabase
    .from("sales_orders")
    .select("id, raw_json, date_created_marketplace, marketplace_account_id, seller_company_id")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .order("date_created_marketplace", { ascending: false })
    .limit(5000);
  if (scopedAccountId) q = q.eq("marketplace_account_id", scopedAccountId);
  if (scopedSellerCompanyId) q = q.eq("seller_company_id", scopedSellerCompanyId);
  if (saleDateFrom) q = q.gte("date_created_marketplace", String(saleDateFrom));

  const { data: orders, error } = await q;
  if (error) {
    if (isMissingTableOrColumn(error)) return out;
    throw error;
  }

  for (const order of orders ?? []) {
    out.processedOrders += 1;
    const buyer = pickBuyer(order?.raw_json);
    if (!buyer.externalId) {
      out.withoutCustomer += 1;
      out.skippedOrders += 1;
      continue;
    }

    const row = {
      user_id: userId,
      marketplace,
      marketplace_account_id: scopedAccountId,
      seller_company_id: scopedSellerCompanyId,
      external_customer_id: buyer.externalId,
      name: buyer.name,
      email: buyer.email,
      phone: buyer.phone,
      raw_json: order?.raw_json ?? {},
      updated_at: new Date().toISOString(),
    };

    const up = await upsertMarketplaceCustomer(supabase, row, {
      allowLegacyFallback: !scopedAccountId,
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
  }

  return out;
}

