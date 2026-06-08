import Decimal from "decimal.js";

/** @param {unknown} v */
function toDecimal(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d */
function moneyDecimal(d) {
  if (d == null) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** @param {unknown} v */
function toQty(v) {
  const n = toDecimal(v);
  if (n == null) return 1;
  const q = Math.trunc(n.toNumber());
  return q > 0 ? q : 1;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} companyId
 */
async function loadSellerCompanyTaxRate(supabase, userId, companyId) {
  const { data: company, error } = await supabase
    .from("seller_companies")
    .select("id,default_tax_rate,tax_regime,company_name,trade_name,document_cnpj")
    .eq("user_id", userId)
    .eq("id", companyId)
    .maybeSingle();
  if (error) {
    const msg = String(error.message ?? "").toLowerCase();
    if (!msg.includes("column") && String(error.code ?? "") !== "42703") throw error;
  }
  const rate = toDecimal(company?.default_tax_rate);
  if (rate == null || rate.lt(0) || rate.gt(100)) {
    return { tax_percent: null, tax_regime: company?.tax_regime != null ? String(company.tax_regime) : null };
  }
  return {
    tax_percent: rate.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString(),
    tax_regime: company?.tax_regime != null ? String(company.tax_regime) : null,
  };
}

/**
 * Resolve alíquota de imposto interno por CNPJ/empresa da venda (multi-conta).
 *
 * Prioridade:
 * 1. seller_company_id do pedido/item
 * 2. seller_company_id da marketplace_account_id
 * 3. profiles.imposto_percentual somente sem vínculo de empresa
 * 4. null → missing_tax_profile
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   seller_company_id?: string | null;
 *   marketplace_account_id?: string | null;
 * }} ctx
 */
export async function resolveSaleInternalTaxProfile(supabase, userId, ctx = {}) {
  const marketplaceAccountId =
    ctx.marketplace_account_id != null ? String(ctx.marketplace_account_id).trim() : "";
  let sellerCompanyId = ctx.seller_company_id != null ? String(ctx.seller_company_id).trim() : "";
  /** @type {string | null} */
  let internalTaxSource = null;

  if (!sellerCompanyId && marketplaceAccountId) {
    const { data: account, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select("id,seller_company_id")
      .eq("user_id", userId)
      .eq("id", marketplaceAccountId)
      .maybeSingle();
    if (accErr) {
      const msg = String(accErr.message ?? "").toLowerCase();
      if (!msg.includes("column") && String(accErr.code ?? "") !== "42703") throw accErr;
    }
    const linkedCompanyId =
      account?.seller_company_id != null ? String(account.seller_company_id).trim() : "";
    if (linkedCompanyId) {
      sellerCompanyId = linkedCompanyId;
      internalTaxSource = "marketplace_account_seller_company_tax_profile";
    }
  }

  if (sellerCompanyId) {
    const companyTax = await loadSellerCompanyTaxRate(supabase, userId, sellerCompanyId);
    if (companyTax.tax_percent != null) {
      return {
        tax_percent: companyTax.tax_percent,
        source: internalTaxSource ?? "seller_company_tax_profile",
        seller_company_id: sellerCompanyId,
        marketplace_account_id: marketplaceAccountId || null,
        tax_regime: companyTax.tax_regime,
      };
    }
    return {
      tax_percent: null,
      source: "missing_tax_profile",
      seller_company_id: sellerCompanyId,
      marketplace_account_id: marketplaceAccountId || null,
      tax_regime: companyTax.tax_regime,
    };
  }

  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("imposto_percentual")
    .eq("id", userId)
    .maybeSingle();
  if (pErr) throw pErr;

  const profileRate = toDecimal(profile?.imposto_percentual);
  if (profileRate != null && profileRate.gte(0) && profileRate.lte(100)) {
    return {
      tax_percent: profileRate.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString(),
      source: "profile_fallback",
      seller_company_id: null,
      marketplace_account_id: marketplaceAccountId || null,
      tax_regime: null,
    };
  }

  return {
    tax_percent: null,
    source: "missing_tax_profile",
    seller_company_id: null,
    marketplace_account_id: marketplaceAccountId || null,
    tax_regime: null,
  };
}

/** @deprecated use resolveSaleInternalTaxProfile */
export async function fetchSellerInternalTaxPercent(supabase, userId, sellerCompanyId) {
  return resolveSaleInternalTaxProfile(supabase, userId, { seller_company_id: sellerCompanyId });
}

/**
 * @param {{
 *   product?: Record<string, unknown> | null;
 *   productId?: string | null;
 *   qty?: number;
 *   grossDec?: Decimal | null;
 *   taxPercent?: string | null;
 *   taxPercentSource?: string | null;
 *   seller_company_id?: string | null;
 *   marketplace_account_id?: string | null;
 * }} ctx
 */
export function buildSaleDetailInternalCostsContract(ctx) {
  const qty = ctx.qty != null && ctx.qty > 0 ? Math.trunc(ctx.qty) : 1;
  const product = ctx.product && typeof ctx.product === "object" ? ctx.product : null;
  const productId = ctx.productId != null ? String(ctx.productId).trim() : "";
  const grossDec = ctx.grossDec ?? null;
  const sellerCompanyId = ctx.seller_company_id != null ? String(ctx.seller_company_id).trim() : null;
  const marketplaceAccountId =
    ctx.marketplace_account_id != null ? String(ctx.marketplace_account_id).trim() : null;

  const costUnit = toDecimal(product?.cost_price);
  const packUnit = toDecimal(product?.packaging_cost);
  const opUnit = toDecimal(product?.operational_cost);
  const qDec = new Decimal(qty);

  const hasProductLink = Boolean(productId && product);

  const productCostDec = costUnit != null && costUnit.gt(0) ? costUnit.mul(qDec) : null;
  const packagingDec = packUnit != null && packUnit.gte(0) ? packUnit.mul(qDec) : null;
  const operationDec = opUnit != null && opUnit.gte(0) ? opUnit.mul(qDec) : null;

  let operationPackagingDec = null;
  if (hasProductLink && (packUnit != null || opUnit != null)) {
    operationPackagingDec = new Decimal(0);
    if (operationDec != null) operationPackagingDec = operationPackagingDec.plus(operationDec);
    if (packagingDec != null) operationPackagingDec = operationPackagingDec.plus(packagingDec);
  }

  const taxPctDec = toDecimal(ctx.taxPercent);
  const taxSource = ctx.taxPercentSource ?? null;
  let internalTaxDec = null;
  if (taxPctDec != null && grossDec != null && grossDec.gt(0)) {
    internalTaxDec = grossDec.mul(taxPctDec).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  let totalInternalDec = null;
  const parts = [productCostDec, internalTaxDec, operationPackagingDec].filter((p) => p != null);
  if (parts.length > 0) {
    totalInternalDec = parts.reduce((acc, p) => acc.plus(/** @type {Decimal} */ (p)), new Decimal(0));
  }

  const hasProductCost = productCostDec != null;
  const hasTaxProfile = taxPctDec != null && taxSource !== "missing_tax_profile";
  const hasOpPack =
    operationPackagingDec != null || (hasProductLink && (packUnit != null || opUnit != null));

  /** @type {"persisted" | "missing_product_link" | "missing_tax_profile" | "partial"} */
  let confidence = "persisted";
  if (!hasProductLink) confidence = "missing_product_link";
  else if (!hasTaxProfile) confidence = "missing_tax_profile";
  else if (!hasProductCost || !hasOpPack) confidence = "partial";

  const internalTaxSourcePath =
    taxSource === "missing_tax_profile"
      ? "missing_tax_profile"
      : hasTaxProfile
        ? taxSource
        : null;

  return {
    product_cost_brl: moneyDecimal(productCostDec),
    internal_tax_brl: moneyDecimal(internalTaxDec),
    packaging_cost_brl: moneyDecimal(packagingDec),
    operation_cost_brl: moneyDecimal(operationDec),
    operation_packaging_cost_brl: moneyDecimal(operationPackagingDec),
    total_internal_cost_brl: moneyDecimal(totalInternalDec),
    tax_percent_applied: hasTaxProfile
      ? taxPctDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : null,
    seller_company_id: sellerCompanyId,
    marketplace_account_id: marketplaceAccountId,
    source: {
      product_cost: hasProductLink ? "product_registration" : null,
      internal_tax: internalTaxSourcePath,
      operation_packaging: hasProductLink ? "product_registration" : null,
    },
    confidence,
  };
}

/**
 * Lucro real = valor recebido marketplace − custos internos disponíveis.
 *
 * @param {{
 *   netReceivedDec: Decimal | null;
 *   internalCosts: ReturnType<typeof buildSaleDetailInternalCostsContract>;
 *   contingencyDec?: Decimal | null;
 * }} ctx
 */
export function computeSaleDetailRealResult(ctx) {
  const { netReceivedDec, internalCosts, contingencyDec = null } = ctx;
  const productDec = toDecimal(internalCosts.product_cost_brl);
  const taxDec = toDecimal(internalCosts.internal_tax_brl);
  const opPackDec = toDecimal(internalCosts.operation_packaging_cost_brl);

  let profitDec = null;
  if (netReceivedDec != null && internalCosts.confidence !== "missing_product_link") {
    profitDec = netReceivedDec;
    if (contingencyDec != null) profitDec = profitDec.minus(contingencyDec);
    if (productDec != null) profitDec = profitDec.minus(productDec);
    if (taxDec != null) profitDec = profitDec.minus(taxDec);
    if (opPackDec != null) profitDec = profitDec.minus(opPackDec);
  }

  return {
    profitDec,
    is_definitive: profitDec != null && internalCosts.confidence === "persisted",
    confidence: internalCosts.confidence === "persisted" ? "complete" : internalCosts.confidence,
  };
}

export { toDecimal as saleDetailMoneyToDecimal, toQty as saleDetailToQty, moneyDecimal as saleDetailMoneyDecimal };
