// ======================================================================
// SUSE7 — Create Product (lógica de INSERT)
// Usado pelo upsert quando mode === "create"
// Responsabilidades:
// - Validar payload mínimo (product_name, format)
// - Normalizar ad_titles
// - Montar insert em public.products
// - Inserir e retornar productId
// - TODO: variants (product_variants) quando format === "variants"
// ======================================================================

import { normalizeAdTitles } from "../../utils/normalizeAdTitles.js";
import { normalizeProductPayload } from "../../domain/ProductDomainService.js";

// ----------------------------------------------------------------------
// Helper: converte string decimal para número (evita float impreciso)
// ----------------------------------------------------------------------
function toNum(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().replace(",", ".");
  if (s === "") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Monta payload de insert para public.products (CREATE).
 * user_id vem de auth.uid (NUNCA do client).
 * @param {Record<string, unknown>} product - produto normalizado
 * @param {string} userId - auth.uid
 * @returns {Record<string, unknown>}
 */
export function buildProductInsertPayload(product, userId) {
  const p = product || {};
  const format = String(p.format || "simple").toLowerCase();
  const validFormat = format === "variants" ? "variants" : "simple";

  const adTitles = normalizeAdTitles(p.ad_titles);

  const insert = {
    user_id: userId,
    product_name: String(p.product_name ?? "").trim() || null,
    format: validFormat,
    sku: p.sku != null ? String(p.sku).trim() || null : null,
    gtin: p.gtin != null ? String(p.gtin).trim() || null : null,
    ncm: p.ncm != null ? String(p.ncm).trim() || null : null,
    brand: p.brand != null ? String(p.brand).trim() || null : null,
    model: p.model != null ? String(p.model).trim() || null : null,
    seo_keywords: p.seo_keywords != null ? String(p.seo_keywords).trim() || null : null,
    description: p.description != null ? String(p.description).trim() || null : null,
    notes: p.notes != null ? String(p.notes).trim() || null : null,
    status: "draft",
    active: p.active !== false,

    // Custos (numeric)
    cost_price: toNum(p.cost_price),
    packaging_cost: toNum(p.packaging_cost),
    operational_cost: toNum(p.operational_cost),

    // Estoque (simple)
    stock_quantity: toInt(p.stock_quantity),
    stock_minimum: toInt(p.stock_minimum),
    use_virtual_stock: Boolean(p.use_virtual_stock),
    virtual_stock_quantity: toInt(p.virtual_stock_quantity) ?? 0,

    // Pesos & medidas
    width: toNum(p.width),
    height: toNum(p.height),
    length: toNum(p.length),
    weight: toNum(p.weight),
    assembled_width: toNum(p.assembled_width),
    assembled_height: toNum(p.assembled_height),
    assembled_length: toNum(p.assembled_length),
    assembled_weight: toNum(p.assembled_weight),

    // Títulos do anúncio (jsonb)
    ad_titles: adTitles,
  };

  return insert;
}

/**
 * Valida payload mínimo para CREATE.
 * @param {Record<string, unknown>} product
 * @returns {{ valid: boolean; code?: string; message?: string }}
 */
export function validateCreatePayload(product) {
  if (!product || typeof product !== "object") {
    return { valid: false, code: "INVALID_INPUT", message: "product é obrigatório" };
  }

  const name = String(product.product_name ?? "").trim();
  if (!name) {
    return { valid: false, code: "INVALID_INPUT", message: "product_name é obrigatório" };
  }

  const format = String(product.format ?? "simple").toLowerCase();
  if (format !== "simple" && format !== "variants") {
    return { valid: false, code: "INVALID_INPUT", message: "format deve ser 'simple' ou 'variants'" };
  }

  return { valid: true };
}
