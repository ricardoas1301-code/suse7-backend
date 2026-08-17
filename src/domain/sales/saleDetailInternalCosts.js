import Decimal from "decimal.js";

export const S7_INTERNAL_COSTS_SNAPSHOT_VERSION = "s7_internal_costs_v1";

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

/**
 * @param {Record<string, unknown> | null | undefined} item
 */
function resolveInternalCostsSnapshot(item) {
  const raw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const fin =
    raw?._s7_financial && typeof raw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (raw._s7_financial)
      : null;
  const snap =
    fin?.internal_costs_snapshot && typeof fin.internal_costs_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.internal_costs_snapshot)
      : null;

  const productSnap =
    fin?.product_cost_snapshot && typeof fin.product_cost_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.product_cost_snapshot)
      : null;
  const taxSnap =
    fin?.tax_snapshot && typeof fin.tax_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.tax_snapshot)
      : null;
  const operationalSnap =
    fin?.operational_cost_snapshot && typeof fin.operational_cost_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.operational_cost_snapshot)
      : null;

  const productCostRaw =
    snap?.product_cost_brl ?? productSnap?.amount_brl ?? productSnap?.product_cost_brl ?? null;
  const internalTaxRaw = snap?.internal_tax_brl ?? taxSnap?.amount_brl ?? taxSnap?.tax_amount_brl ?? null;
  const operationPackagingRaw =
    snap?.operation_packaging_cost_brl ??
    operationalSnap?.operation_packaging_cost_brl ??
    operationalSnap?.amount_brl ??
    null;
  const packagingRaw = snap?.packaging_cost_brl ?? operationalSnap?.packaging_cost_brl ?? null;
  const operationRaw = snap?.operation_cost_brl ?? operationalSnap?.operation_cost_brl ?? null;
  const totalInternalRaw =
    snap?.total_internal_cost_brl ??
    (toDecimal(productCostRaw) != null ||
    toDecimal(internalTaxRaw) != null ||
    toDecimal(operationPackagingRaw) != null
      ? moneyDecimal(
          [productCostRaw, internalTaxRaw, operationPackagingRaw]
            .map((v) => toDecimal(v))
            .filter((v) => v != null)
            .reduce((acc, v) => acc.plus(/** @type {Decimal} */ (v)), new Decimal(0)),
        )
      : null);
  if (!snap && !productSnap && !taxSnap && !operationalSnap) return null;

  const hasAnyAmount =
    toDecimal(productCostRaw) != null ||
    toDecimal(internalTaxRaw) != null ||
    toDecimal(operationPackagingRaw) != null;
  if (!hasAnyAmount) return null;

  const qualityRaw = String(
    snap?.snapshot_quality ?? fin?.snapshot_quality ?? "historical",
  )
    .trim()
    .toLowerCase();
  const snapshot_quality =
    qualityRaw === "reconstructed" || qualityRaw === "estimated" ? "reconstructed" : "historical";
  const confidenceRaw = String(snap?.confidence ?? "").trim().toLowerCase();
  const confidence =
    confidenceRaw === "persisted" || confidenceRaw === "partial" || confidenceRaw === "missing_tax_profile"
      ? confidenceRaw
      : "persisted";

  return {
    product_cost_brl: moneyDecimal(toDecimal(productCostRaw)),
    internal_tax_brl: moneyDecimal(toDecimal(internalTaxRaw)),
    packaging_cost_brl: moneyDecimal(toDecimal(packagingRaw)),
    operation_cost_brl: moneyDecimal(toDecimal(operationRaw)),
    operation_packaging_cost_brl: moneyDecimal(toDecimal(operationPackagingRaw)),
    total_internal_cost_brl:
      moneyDecimal(toDecimal(totalInternalRaw)) ??
      moneyDecimal(
        [productCostRaw, internalTaxRaw, operationPackagingRaw]
          .map((v) => toDecimal(v))
          .filter((v) => v != null)
          .reduce((acc, v) => acc.plus(/** @type {Decimal} */ (v)), new Decimal(0)),
      ),
    tax_percent_applied:
      toDecimal(snap?.tax_percent_applied ?? taxSnap?.tax_percent_applied) != null
        ? /** @type {Decimal} */ (
            toDecimal(snap?.tax_percent_applied ?? taxSnap?.tax_percent_applied)
          )
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2)
        : null,
    seller_company_id:
      snap?.seller_company_id != null && String(snap.seller_company_id).trim() !== ""
        ? String(snap.seller_company_id).trim()
        : null,
    marketplace_account_id:
      snap?.marketplace_account_id != null && String(snap.marketplace_account_id).trim() !== ""
        ? String(snap.marketplace_account_id).trim()
        : null,
    source: {
      product_cost: "financial_snapshot.internal_costs",
      internal_tax: "financial_snapshot.internal_costs",
      operation_packaging: "financial_snapshot.internal_costs",
    },
    confidence,
    snapshot: {
      source: "historical_financial_snapshot",
      snapshot_quality,
      snapshot_version:
        snap?.snapshot_version != null && String(snap.snapshot_version).trim() !== ""
          ? String(snap.snapshot_version).trim()
          : S7_INTERNAL_COSTS_SNAPSHOT_VERSION,
      estimated: snapshot_quality === "reconstructed",
    },
  };
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
  const snapshotContract = resolveInternalCostsSnapshot(ctx.item ?? null);
  if (snapshotContract) return snapshotContract;

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
    snapshot: {
      source: "reconstructed_runtime",
      snapshot_quality: "reconstructed",
      snapshot_version: S7_INTERNAL_COSTS_SNAPSHOT_VERSION,
      estimated: true,
    },
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
