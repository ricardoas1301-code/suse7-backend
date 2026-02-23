// ======================================================================
// SUSE7 — Product Status Domain Service
// Máquina de estados leve para ciclo de vida do produto
// ======================================================================

// ----------------------------------------------------------------------
// Transições permitidas
// ----------------------------------------------------------------------

export const PRODUCT_STATUS_TRANSITIONS = {
  draft: ["ready"],
  ready: ["draft", "published"],
  published: ["blocked"],
  blocked: ["ready"],
};

const VALID_STATUSES = new Set(["draft", "ready", "published", "blocked"]);

// ----------------------------------------------------------------------
// Validações
// ----------------------------------------------------------------------

/**
 * Valida transição de status.
 * Se currentStatus === nextStatus → permitir (no-op).
 *
 * @param {string} currentStatus
 * @param {string} nextStatus
 * @returns {{ valid: boolean; code?: string; message?: string; details?: object }}
 */
export function validateStatusTransition(currentStatus, nextStatus) {
  const curr = (currentStatus || "draft").toLowerCase();
  const next = (nextStatus || "").toLowerCase();

  if (curr === next) {
    return { valid: true };
  }

  if (!VALID_STATUSES.has(next)) {
    return {
      valid: false,
      code: "INVALID_STATUS_TRANSITION",
      message: "Status inválido.",
      details: { currentStatus: curr, nextStatus: next },
    };
  }

  const allowed = PRODUCT_STATUS_TRANSITIONS[curr];
  if (!allowed || !allowed.includes(next)) {
    return {
      valid: false,
      code: "INVALID_STATUS_TRANSITION",
      message: "Transição de status não permitida.",
      details: { currentStatus: curr, nextStatus: next },
    };
  }

  return { valid: true };
}

/**
 * Valida requisitos para mudar para 'ready'.
 *
 * @param {object} product - produto normalizado
 * @param {object[]} [variants] - variações (quando format=variants)
 * @returns {{ valid: boolean; code?: string; message?: string; details?: { missingFields: string[] } }}
 */
export function validateReadyRequirements(product, variants = []) {
  const missing = [];

  const name = product?.product_name ?? product?.name ?? "";
  if (!name || String(name).trim() === "") {
    missing.push("product_name");
  }

  const format = (product?.format || "simple").toLowerCase();

  if (format === "simple") {
    const sku = product?.sku ?? "";
    if (!sku || String(sku).trim() === "") {
      missing.push("sku");
    }
  }

  if (format === "variants") {
    const arr = Array.isArray(variants) ? variants : [];
    if (arr.length === 0) {
      missing.push("variants");
    }
  }

  const costPrice = product?.cost_price;
  if (costPrice == null || String(costPrice).trim() === "") {
    missing.push("cost_price");
  } else {
    const n = parseFloat(String(costPrice).replace(",", "."));
    if (Number.isNaN(n) || n <= 0) {
      missing.push("cost_price");
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      code: "PRODUCT_NOT_READY",
      message: "Produto não atende os requisitos para ficar pronto.",
      details: { missingFields: missing },
    };
  }

  return { valid: true };
}
