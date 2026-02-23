// ======================================================================
// SUSE7 — Product Domain Service
// Validações e normalização (backend como fonte de verdade)
// ======================================================================

// ----------------------------------------------------------------------
// Normalização
// ----------------------------------------------------------------------

/**
 * Normaliza SKU para comparação de unicidade.
 * - trim
 * - uppercase
 * - colapsar espaços internos (múltiplos → um)
 * @param {string} sku
 * @returns {string}
 */
export function normalizeSku(sku) {
  if (sku == null || typeof sku !== "string") return "";
  return sku
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Normaliza payload de produto para persistência.
 * - trim em strings principais
 * - sku: trim + uppercase + remover espaços duplicados
 * - ean/gtin: somente números (strip non-digits)
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
export function normalizeProductPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const out = { ...payload };

  const trimStr = (v) => (typeof v === "string" ? v.trim() : v);
  const strFields = [
    "product_name",
    "brand",
    "model",
    "ncm",
    "description",
    "notes",
    "seo_keywords",
  ];
  for (const f of strFields) {
    if (out[f] != null) out[f] = trimStr(out[f]);
  }

  if (out.sku != null && typeof out.sku === "string") {
    out.sku = normalizeSku(out.sku);
  }

  const digitsOnly = (v) => (typeof v === "string" ? v.replace(/\D/g, "") : v);
  if (out.gtin != null) out.gtin = digitsOnly(out.gtin);
  if (out.ean != null) out.ean = digitsOnly(out.ean);

  return out;
}

// ----------------------------------------------------------------------
// Validações
// ----------------------------------------------------------------------

/**
 * Valida campos obrigatórios (preparar estrutura, sem travar modo rascunho).
 * @param {Record<string, unknown>} payload
 * @param {{ mode?: string; isDraft?: boolean }} ctx
 * @returns {{ valid: boolean; errors?: string[] }}
 */
export function validateRequiredFields(payload, ctx = {}) {
  const errors = [];
  const mode = ctx.mode || "create";
  const isDraft = ctx.isDraft ?? false;

  if (isDraft) {
    return { valid: true };
  }

  if (!payload?.product_name || String(payload.product_name).trim() === "") {
    errors.push("Nome do produto é obrigatório.");
  }

  const format = (payload.format || "simple").toLowerCase();
  if (format === "simple") {
    if (!payload.sku || String(payload.sku).trim() === "") {
      errors.push("SKU é obrigatório no formato simples.");
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Valida transição de formato.
 * Regra: produto salvo como "variants" NÃO pode voltar para "simple".
 * @param {{ format?: string } | null} currentProduct - produto atual no banco
 * @param {{ format?: string } | null} payload - payload da requisição
 * @returns {{ valid: boolean; code?: string; message?: string }}
 */
export function validateFormatTransition(currentProduct, payload) {
  if (!currentProduct || !payload) return { valid: true };

  const currentFormat = (currentProduct.format || "simple").toLowerCase();
  const newFormat = (payload.format || "simple").toLowerCase();

  if (currentFormat === "variants" && newFormat === "simple") {
    return {
      valid: false,
      code: "FORMAT_LOCK_VARIATIONS",
      message: "Produto com variações não pode ser convertido para simples após salvo.",
    };
  }

  return { valid: true };
}

// ----------------------------------------------------------------------
// Validação SKU único (Nível A: payload | Nível B: banco)
// ----------------------------------------------------------------------

/**
 * Valida unicidade de SKU em dois níveis:
 * - Nível A: dentro do payload (variations) — sem duplicatas entre variações
 * - Nível B: contra o banco — nenhum produto/variante do user pode ter mesmo SKU
 *
 * @param {Record<string, unknown>} payload - produto normalizado
 * @param {Array<{ sku?: string }>} [variants] - variações (quando format=variants)
 * @param {{ supabase: import("@supabase/supabase-js").SupabaseClient; userId: string; productId?: string }} ctx
 * @returns {Promise<{ valid: boolean; code?: string; message?: string; details?: { sku: string; scope: "payload"|"database"; collisionProductId?: string } }>}
 */
export async function validateSkuUniqueness(payload, variants, ctx) {
  const { supabase, userId, productId } = ctx || {};
  if (!supabase || !userId) {
    return { valid: true };
  }

  const format = (payload?.format || "simple").toLowerCase();
  const skusToCheck = [];

  if (format === "simple") {
    const sku = payload?.sku;
    if (sku != null && String(sku).trim() !== "") {
      skusToCheck.push({ sku: normalizeSku(String(sku)), raw: sku });
    }
  } else if (format === "variants" && Array.isArray(variants)) {
    // ------------------------------------------------------------------
    // Nível A: duplicatas dentro do payload
    // ------------------------------------------------------------------
    const seen = new Map();
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const raw = v?.sku != null ? String(v.sku) : "";
      if (raw.trim() === "") continue;

      const norm = normalizeSku(raw);
      if (seen.has(norm)) {
        return {
          valid: false,
          code: "SKU_DUPLICATE",
          message: "SKU já existe para este seller.",
          details: { sku: norm, scope: "payload" },
        };
      }
      seen.set(norm, true);
      skusToCheck.push({ sku: norm, raw });
    }
  }

  if (skusToCheck.length === 0) return { valid: true };

  // ------------------------------------------------------------------
  // Nível B: colisão contra o banco (products + product_variants)
  // ------------------------------------------------------------------

  // 1) Produtos simples (sku na tabela products)
  const { data: products } = await supabase
    .from("products")
    .select("id, sku")
    .eq("user_id", userId)
    .eq("format", "simple")
    .not("sku", "is", null);

  const normSet = new Set(skusToCheck.map((s) => s.sku));
  for (const p of products || []) {
    const norm = normalizeSku(p.sku || "");
    if (norm === "") continue;
    if (!normSet.has(norm)) continue;
    if (productId && p.id === productId) continue;

    return {
      valid: false,
      code: "SKU_DUPLICATE",
      message: "SKU já existe para este seller.",
      details: { sku: norm, scope: "database", collisionProductId: p.id },
    };
  }

  // 2) Variações (product_variants.sku, via products.user_id)
  const { data: userProducts } = await supabase
    .from("products")
    .select("id")
    .eq("user_id", userId);

  const userProductIds = (userProducts || []).map((p) => p.id).filter(Boolean);
  if (userProductIds.length === 0) return { valid: true };

  const { data: variantsInDb } = await supabase
    .from("product_variants")
    .select("id, sku, product_id")
    .in("product_id", userProductIds)
    .not("sku", "is", null);

  for (const v of variantsInDb || []) {
    const norm = normalizeSku(v.sku || "");
    if (norm === "") continue;
    if (!normSet.has(norm)) continue;
    if (productId && v.product_id === productId) continue;

    return {
      valid: false,
      code: "SKU_DUPLICATE",
      message: "SKU já existe para este seller.",
      details: { sku: norm, scope: "database", collisionProductId: v.product_id },
    };
  }

  return { valid: true };
}
