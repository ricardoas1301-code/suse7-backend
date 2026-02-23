// ======================================================================
// SUSE7 — User Preferences Domain Service
// Normalização e validação de preferências (modais, avisos, etc.)
// ======================================================================

const MAX_KEY_LENGTH = 100;

// ----------------------------------------------------------------------
// Normalização
// ----------------------------------------------------------------------

/**
 * Normaliza chave para comparação/armazenamento.
 * - trim
 * - lower
 * - substituir espaços por underscore
 * @param {string} key
 * @returns {string} ex: "modal_stock_warning"
 */
export function normalizeKey(key) {
  if (key == null || typeof key !== "string") return "";
  return key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

// ----------------------------------------------------------------------
// Validação
// ----------------------------------------------------------------------

/**
 * Valida chave de preferência.
 * @param {string} key
 * @returns {{ valid: boolean; code?: string; message?: string }}
 */
export function validateKey(key) {
  const norm = normalizeKey(key);
  if (!norm || norm.length === 0) {
    return {
      valid: false,
      code: "KEY_INVALID",
      message: "Chave não pode ser vazia.",
    };
  }
  if (norm.length > MAX_KEY_LENGTH) {
    return {
      valid: false,
      code: "KEY_INVALID",
      message: `Chave excede ${MAX_KEY_LENGTH} caracteres.`,
    };
  }
  return { valid: true };
}

// ----------------------------------------------------------------------
// Persistência
// ----------------------------------------------------------------------

/**
 * Upsert preferência (insert ou update).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} key - chave normalizada
 * @param {object} value - valor JSON (será armazenado como jsonb)
 * @returns {Promise<{ data?: object; error?: Error }>}
 */
export async function upsertPreference(supabase, userId, key, value) {
  if (!supabase || !userId || !key) {
    return { error: new Error("supabase, userId e key são obrigatórios") };
  }

  const payload = {
    user_id: userId,
    key,
    value: value != null && typeof value === "object" ? value : {},
  };

  const { data, error } = await supabase
    .from("user_preferences")
    .upsert(payload, { onConflict: "user_id,key" })
    .select("id, user_id, key, value, created_at, updated_at")
    .single();

  return { data, error };
}

/**
 * Busca preferências do usuário, opcionalmente filtradas por prefixo.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} [prefix] - ex: "modal." filtra keys que começam com "modal."
 * @returns {Promise<{ data?: object[]; error?: Error }>}
 */
export async function getPreferences(supabase, userId, prefix = null) {
  if (!supabase || !userId) {
    return { error: new Error("supabase e userId são obrigatórios") };
  }

  let query = supabase
    .from("user_preferences")
    .select("id, key, value, created_at, updated_at")
    .eq("user_id", userId)
    .order("key", { ascending: true });

  if (prefix && typeof prefix === "string" && prefix.length > 0) {
    query = query.ilike("key", `${prefix}%`);
  }

  const { data, error } = await query;
  return { data: data || [], error };
}
