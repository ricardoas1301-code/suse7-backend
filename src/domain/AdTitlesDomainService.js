// ======================================================================
// SUSE7 — Ad Titles Domain Service
// Normalização e validação de títulos de anúncios (até 10 por produto)
// ======================================================================

// ----------------------------------------------------------------------
// Normalização
// ----------------------------------------------------------------------

/**
 * Normaliza título para exibição/armazenamento.
 * - trim
 * - colapsar espaços internos (múltiplos → um)
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (title == null || typeof title !== "string") return "";
  return title
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Normaliza título para comparação de unicidade (case-insensitive).
 * - lower + trim + colapsar espaços
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitleKey(title) {
  if (title == null || typeof title !== "string") return "";
  return normalizeTitle(title).toLowerCase();
}

// ----------------------------------------------------------------------
// Validações
// ----------------------------------------------------------------------

/**
 * Valida que o título não está vazio (após normalização).
 * @param {string} title
 * @returns {{ valid: boolean; code?: string; message?: string }}
 */
export function validateTitleNotEmpty(title) {
  const norm = normalizeTitle(title);
  if (!norm || norm.length === 0) {
    return {
      valid: false,
      code: "TITLE_EMPTY",
      message: "Título não pode ser vazio.",
    };
  }
  return { valid: true };
}

/**
 * Valida limite máximo de 10 títulos por produto.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @param {string} [excludeId] - id a excluir da contagem (para PATCH)
 * @returns {Promise<{ valid: boolean; code?: string; message?: string; count?: number }>}
 */
export async function validateNewTitleLimit(supabase, userId, productId, excludeId = null) {
  if (!supabase || !userId || !productId) {
    return { valid: true };
  }

  let query = supabase
    .from("product_ad_titles")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("product_id", productId);

  if (excludeId) {
    query = query.neq("id", excludeId);
  }

  const { count, error } = await query;

  if (error) {
    console.error("[AdTitlesDomainService] validateNewTitleLimit error:", error);
    return { valid: false, code: "DB_ERROR", message: "Erro ao verificar limite de títulos." };
  }

  const currentCount = count ?? 0;
  if (currentCount >= 10) {
    return {
      valid: false,
      code: "MAX_TITLES_REACHED",
      message: "Máximo de 10 títulos por produto atingido.",
      count: currentCount,
    };
  }

  return { valid: true, count: currentCount };
}

/**
 * Verifica se já existe título duplicado (case-insensitive) para o produto.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} productId
 * @param {string} titleNormalized - título já normalizado (normalizeTitleKey)
 * @param {string} [excludeId] - id a excluir (para PATCH)
 * @returns {Promise<{ valid: boolean; code?: string; message?: string }>}
 */
export async function validateTitleNotDuplicate(supabase, userId, productId, titleNormalized, excludeId = null) {
  if (!supabase || !userId || !productId || !titleNormalized) {
    return { valid: true };
  }

  let query = supabase
    .from("product_ad_titles")
    .select("id")
    .eq("user_id", userId)
    .eq("product_id", productId)
    .eq("title_normalized", titleNormalized)
    .limit(1);

  if (excludeId) {
    query = query.neq("id", excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[AdTitlesDomainService] validateTitleNotDuplicate error:", error);
    return { valid: false, code: "DB_ERROR", message: "Erro ao verificar duplicidade." };
  }

  if (data && data.length > 0) {
    return {
      valid: false,
      code: "TITLE_DUPLICATE",
      message: "Título duplicado para este produto.",
    };
  }

  return { valid: true };
}
