function isMissingTableOrColumn(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("column");
}

function pickBuyer(orderRaw) {
  const buyer = orderRaw?.buyer && typeof orderRaw.buyer === "object" ? orderRaw.buyer : {};
  const externalId = buyer.id != null ? String(buyer.id) : null;
  const name =
    buyer.nickname != null && String(buyer.nickname).trim() !== ""
      ? String(buyer.nickname).trim()
      : buyer.first_name != null && String(buyer.first_name).trim() !== ""
        ? String(buyer.first_name).trim()
        : null;
  const email = buyer.email != null ? String(buyer.email).trim() || null : null;
  const phone =
    buyer.phone && typeof buyer.phone === "object" && buyer.phone.number != null
      ? String(buyer.phone.number).trim() || null
      : null;
  return { externalId, name, email, phone };
}

async function upsertMarketplaceCustomer(supabase, row) {
  const variants = [
    {
      row,
      onConflict: "user_id,marketplace,marketplace_account_id,external_customer_id",
    },
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
    skippedOrders: 0,
    errors: [],
  };

  let q = supabase
    .from("sales_orders")
    .select("id, raw_json, date_created_marketplace")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .order("date_created_marketplace", { ascending: false })
    .limit(5000);
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
      out.skippedOrders += 1;
      continue;
    }

    const row = {
      user_id: userId,
      marketplace,
      marketplace_account_id: marketplaceAccountId || null,
      seller_company_id: sellerCompanyId || null,
      external_customer_id: buyer.externalId,
      name: buyer.name,
      email: buyer.email,
      phone: buyer.phone,
      raw_json: order?.raw_json ?? {},
      updated_at: new Date().toISOString(),
    };

    const up = await upsertMarketplaceCustomer(supabase, row);
    if (!up.ok) {
      out.errors.push(String(up.error?.message ?? "customer_upsert_failed"));
      continue;
    }
    out.upsertedCustomers += 1;
  }

  return out;
}

