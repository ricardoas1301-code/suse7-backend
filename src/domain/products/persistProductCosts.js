// ======================================================================
// Persistência canônica de custos do produto (unitário + lote).
// SSOT: public.products (cost_price, packaging_cost, operational_cost)
// + catalog_completeness + syncListingsFinancialBlockForProduct
// ======================================================================

import Decimal from "decimal.js";
import {
  hasRequiredProductCosts,
  resolveCatalogCompleteness,
} from "../productCatalogCompleteness.js";
import { syncListingsFinancialBlockForProduct } from "../../handlers/ml/_helpers/mlListingProductLink.js";
import { aplicarCutoverPrimeiroCustoProdutoEmVendasPendentes } from "./aplicarCutoverPrimeiroCustoProduto.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} productId
 */
export function isValidProductId(productId) {
  return typeof productId === "string" && productId.trim() !== "" && UUID_REGEX.test(productId.trim());
}

/**
 * @param {unknown} raw
 * @param {{ allowZero?: boolean }} [opts]
 */
export function parseMoneyDecimalString(raw, opts = {}) {
  const allowZero = opts.allowZero !== false;
  if (raw == null || String(raw).trim() === "") {
    return { ok: false, code: "REQUIRED", message: "Valor obrigatório" };
  }
  try {
    const normalized = String(raw).trim().replace(/\s/g, "").replace(",", ".");
    const d = new Decimal(normalized);
    if (!d.isFinite() || d.isNegative()) {
      return { ok: false, code: "INVALID_MONEY", message: "Valor monetário inválido" };
    }
    if (!allowZero && !d.gt(0)) {
      return { ok: false, code: "COST_MUST_BE_POSITIVE", message: "Custo do produto deve ser maior que zero" };
    }
    return { ok: true, value: d.toFixed(2) };
  } catch {
    return { ok: false, code: "INVALID_MONEY", message: "Valor monetário inválido" };
  }
}

/**
 * @param {{ cost_price?: unknown; packaging_cost?: unknown; operational_cost?: unknown }} payload
 */
/**
 * Embalagem / Insumo (campo products.operational_cost) opcionais → default 0.00.
 * Não altera regra de custo operacional (%) da empresa.
 * @param {unknown} raw
 */
function parseOptionalProductMoneyOrZero(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { ok: true, value: "0.00" };
  }
  return parseMoneyDecimalString(raw, { allowZero: true });
}

export function validateProductCostsPayload(payload) {
  const costPrice = parseMoneyDecimalString(payload?.cost_price, { allowZero: false });
  if (!costPrice.ok) {
    return {
      ok: false,
      code: costPrice.code,
      message: costPrice.message || "Custo do produto inválido",
      field: "cost_price",
    };
  }

  const packagingCost = parseOptionalProductMoneyOrZero(payload?.packaging_cost);
  if (!packagingCost.ok) {
    return {
      ok: false,
      code: packagingCost.code,
      message: packagingCost.message || "Custo embalagem inválido",
      field: "packaging_cost",
    };
  }

  // products.operational_cost = Insumo (expedição), NÃO custo operacional da empresa
  const operationalCost = parseOptionalProductMoneyOrZero(payload?.operational_cost);
  if (!operationalCost.ok) {
    return {
      ok: false,
      code: operationalCost.code,
      message: operationalCost.message || "Custo de insumo inválido",
      field: "operational_cost",
    };
  }

  const costs = {
    cost_price: costPrice.value,
    packaging_cost: packagingCost.value,
    operational_cost: operationalCost.value,
  };

  if (!hasRequiredProductCosts(costs.cost_price, costs.packaging_cost, costs.operational_cost)) {
    return {
      ok: false,
      code: "INCOMPLETE_COSTS",
      message: "Preencha o custo do produto (> 0)",
      field: "cost_price",
    };
  }

  return { ok: true, costs };
}

/**
 * @param {unknown} costPrice
 * @param {unknown} packagingCost
 * @param {unknown} operationalCost
 */
export function isProductCostsIncomplete(costPrice, packagingCost, operationalCost) {
  return !hasRequiredProductCosts(costPrice, packagingCost, operationalCost);
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   userId: string;
 *   productId: string;
 *   costs: { cost_price: string; packaging_cost: string; operational_cost: string };
 * }} params
 */
export async function persistProductCostsForUser({ supabase, userId, productId, costs }) {
  const pid = String(productId).trim();
  if (!isValidProductId(pid)) {
    return { ok: false, code: "INVALID_INPUT", message: "product_id inválido" };
  }

  const { data: existing, error: fetchError } = await supabase
    .from("products")
    .select("id, user_id, catalog_source, cost_price, packaging_cost, operational_cost")
    .eq("id", pid)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchError) {
    return { ok: false, code: "DB_ERROR", message: fetchError.message || "Erro ao carregar produto" };
  }
  if (!existing) {
    return { ok: false, code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" };
  }

  const previousCostPrice = existing.cost_price;

  const catalogCompleteness = resolveCatalogCompleteness(costs, {
    catalog_source: existing.catalog_source,
  });

  const { error: updateError } = await supabase
    .from("products")
    .update({
      cost_price: costs.cost_price,
      packaging_cost: costs.packaging_cost,
      operational_cost: costs.operational_cost,
      catalog_completeness: catalogCompleteness,
      updated_at: new Date().toISOString(),
    })
    .eq("id", pid)
    .eq("user_id", userId);

  if (updateError) {
    return { ok: false, code: "DB_ERROR", message: updateError.message || "Erro ao salvar custos" };
  }

  try {
    await syncListingsFinancialBlockForProduct(supabase, userId, pid, catalogCompleteness);
  } catch {
    /* não bloqueia persistência — espelha tolerância do upsert */
  }

  /** @type {Record<string, unknown> | null} */
  let cutover = null;
  try {
    cutover = await aplicarCutoverPrimeiroCustoProdutoEmVendasPendentes({
      supabase,
      userId,
      productId: pid,
      costs,
      previousCostPrice,
    });
  } catch (e) {
    console.warn("[S7_PRODUCT_COST_CUTOVER] failed", {
      product_id: pid,
      message: e?.message ? String(e.message) : String(e),
    });
  }

  return {
    ok: true,
    product_id: pid,
    catalog_completeness: catalogCompleteness,
    cost_cutover: cutover,
  };
}
