// ======================================================================
// s7_global_customers — dedupe global (documento > email > telefone > id ML)
// Chamado de hot paths: falhas são logadas sem PII e não propagam erro.
// ======================================================================

function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function digitsOnly(v) {
  const s = safeStr(v);
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  return d === "" ? null : d;
}

/** CPF/CNPJ ou documento numérico mínimo para dedupe. */
function normalizeDocument(v) {
  const d = digitsOnly(v);
  if (!d) return null;
  if (d.length === 11 || d.length === 14) return d;
  if (d.length >= 8 && d.length <= 18) return d;
  return null;
}

function normalizeEmail(v) {
  const s = safeStr(v)?.toLowerCase();
  if (!s || !s.includes("@")) return null;
  return s;
}

function normalizePhone(v) {
  if (v && typeof v === "object" && v.number != null) {
    const d = digitsOnly(v.number);
    return d && d.length >= 8 ? d : null;
  }
  const d = digitsOnly(v);
  return d && d.length >= 8 ? d : null;
}

/**
 * Extrai comprador + documento a partir de raw_json de sales_orders (ML e similares).
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
export function extractBuyerForGlobalSync(orderRaw) {
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
  const email = normalizeEmail(buyer.email);
  const phone = normalizePhone(buyer.phone);
  const document_normalized = pickMlBuyerDocument(buyer, orderRaw);
  return { externalId, name, email, phone, document_normalized };
}

/** @param {Record<string, unknown>} buyer @param {unknown} orderRaw */
function pickMlBuyerDocument(buyer, orderRaw) {
  const raw = orderRaw && typeof orderRaw === "object" ? orderRaw : {};
  const candidates = [
    buyer?.billing_info?.identification?.number,
    buyer?.identification?.number,
    raw?.buyer?.billing_info?.identification?.number,
    raw?.buyer?.identification?.number,
  ];
  for (const c of candidates) {
    const n = normalizeDocument(c);
    if (n) return n;
  }
  return null;
}

/**
 * @param {{
 *   document_normalized: string | null;
 *   email: string | null;
 *   phone: string | null;
 *   externalId: string | null;
 *   marketplace: string | null | undefined;
 * }} p
 */
export function resolveGlobalDedupeKey(p) {
  const mp = safeStr(p.marketplace)?.toLowerCase() || "mp";
  if (p.document_normalized) {
    return {
      dedupe_key: `doc:${p.document_normalized}`,
      document_normalized: p.document_normalized,
      email_normalized: p.email,
      phone_normalized: p.phone,
    };
  }
  if (p.email) {
    return {
      dedupe_key: `email:${p.email}`,
      document_normalized: null,
      email_normalized: p.email,
      phone_normalized: p.phone,
    };
  }
  if (p.phone) {
    return {
      dedupe_key: `phone:${p.phone}`,
      document_normalized: null,
      email_normalized: null,
      phone_normalized: p.phone,
    };
  }
  if (p.externalId) {
    return {
      dedupe_key: `${mp}:buyer:${p.externalId}`,
      document_normalized: null,
      email_normalized: p.email,
      phone_normalized: p.phone,
    };
  }
  return null;
}

function sellerEntryKey(e) {
  return `${e.user_id}|${e.marketplace}|${e.external_customer_id ?? ""}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace: string;
 *   marketplaceAccountId: string | null;
 *   sellerCompanyId: string | null;
 *   salesOrderId?: string | null;
 *   orderDateIso: string | null;
 *   orderTotal: number | string | null;
 *   buyerPick: ReturnType<typeof extractBuyerForGlobalSync>;
 *   bumpOrderAggregate: boolean;
 * }} ctx
 */
export async function touchGlobalCustomerFromOrderContext(supabase, ctx) {
  const {
    userId,
    marketplace,
    marketplaceAccountId,
    sellerCompanyId,
    orderDateIso,
    orderTotal,
    buyerPick,
    bumpOrderAggregate,
  } = ctx;

  try {
    if (!buyerPick.externalId && !buyerPick.email && !buyerPick.phone && !buyerPick.document_normalized) {
      return;
    }

    const resolved = resolveGlobalDedupeKey({
      document_normalized: buyerPick.document_normalized,
      email: buyerPick.email,
      phone: buyerPick.phone,
      externalId: buyerPick.externalId,
      marketplace,
    });
    if (!resolved) return;

    const { dedupe_key, document_normalized: docCol, email_normalized: emailCol, phone_normalized: phoneCol } =
      resolved;

    const document_normalized = buyerPick.document_normalized ?? docCol;
    const email_normalized = buyerPick.email ?? emailCol;
    const phone_normalized = buyerPick.phone ?? phoneCol;

    const orderTotalNum = (() => {
      const n = Number(orderTotal);
      return Number.isFinite(n) ? n : 0;
    })();

    const { data: existing, error: exErr } = await supabase
      .from("s7_global_customers")
      .select("*")
      .eq("dedupe_key", dedupe_key)
      .maybeSingle();

    if (exErr) {
      const code = String(exErr.code ?? "");
      const msg = String(exErr.message ?? "").toLowerCase();
      if (code === "42P01" || msg.includes("does not exist")) return;
      console.warn("[s7-global-customers] select_failed", { code: exErr.code });
      return;
    }

    /** @type {unknown[]} */
    let related = Array.isArray(existing?.related_sellers) ? [...existing.related_sellers] : [];
    const entry = {
      user_id: userId,
      marketplace: String(marketplace || ""),
      marketplace_account_id: marketplaceAccountId,
      seller_company_id: sellerCompanyId,
      external_customer_id: buyerPick.externalId,
    };
    if (!related.some((r) => r && typeof r === "object" && sellerEntryKey(r) === sellerEntryKey(entry))) {
      related.push(entry);
    }
    const total_sellers_related = related.length;

    const bump = bumpOrderAggregate === true;
    const prevOrders = Number(existing?.total_orders_global ?? 0) || 0;
    const prevSpent = Number(existing?.total_spent_global ?? 0) || 0;
    const total_orders_global = bump ? prevOrders + 1 : prevOrders;
    const total_spent_global = bump ? Math.round((prevSpent + orderTotalNum) * 100) / 100 : prevSpent;

    const orderDate = orderDateIso ? String(orderDateIso) : null;
    let first_purchase_global = existing?.first_purchase_global ?? null;
    let last_purchase_global = existing?.last_purchase_global ?? null;
    if (orderDate) {
      if (!first_purchase_global || orderDate < first_purchase_global) first_purchase_global = orderDate;
      if (!last_purchase_global || orderDate > last_purchase_global) last_purchase_global = orderDate;
    }

    const name = buyerPick.name || existing?.name || null;

    const row = {
      dedupe_key,
      document_normalized,
      email_normalized,
      phone_normalized,
      name,
      total_orders_global,
      total_spent_global,
      total_sellers_related,
      first_purchase_global,
      last_purchase_global,
      related_sellers: related,
      updated_at: new Date().toISOString(),
    };

    const { error: upErr } = await supabase.from("s7_global_customers").upsert(row, { onConflict: "dedupe_key" });
    if (upErr) {
      console.warn("[s7-global-customers] upsert_failed", { code: upErr.code, message: upErr.message });
    }
  } catch (e) {
    console.warn("[s7-global-customers] touch_failed", { message: e?.message });
  }
}
