// ======================================================
// Último acesso admin — leitura canônica de auth.users.last_sign_in_at.
// Não escreve perfil, sessão nem last_login. Sem fallback de cadastro.
// ======================================================

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function apresentarInstanteAcesso(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (!Number.isFinite(Date.parse(value))) return null;
  return value;
}

/**
 * Lote: um listUsers paginado, mapeado por user_id. Sem N+1.
 * Falha → failed=true e mapa vazio (a UI mostra "—", sem data aparente).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} userIds
 * @param {string} traceId
 * @returns {Promise<{ byUserId: Map<string, string>; failed: boolean }>}
 */
export async function carregarUltimoLoginAuthPorUsuario(supabase, userIds, traceId) {
  const wanted = new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id || "").trim()).filter(Boolean));
  /** @type {Map<string, string>} */
  const byUserId = new Map();
  if (wanted.size === 0) return { byUserId, failed: false };

  let page = 1;
  const perPage = 200;
  try {
    while (page <= 50) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        console.warn("[dev-center-admin] auth_last_sign_in_failed", {
          message: error.message,
          traceId,
        });
        return { byUserId: new Map(), failed: true };
      }
      const users = Array.isArray(data?.users) ? data.users : [];
      if (users.length === 0) break;
      for (const user of users) {
        const id = user?.id != null ? String(user.id) : "";
        if (!id || !wanted.has(id)) continue;
        const presented = apresentarInstanteAcesso(user.last_sign_in_at);
        if (presented) byUserId.set(id, presented);
      }
      if (users.length < perPage) break;
      page += 1;
    }
    return { byUserId, failed: false };
  } catch (error) {
    console.warn("[dev-center-admin] auth_last_sign_in_failed", {
      message: error instanceof Error ? error.message : String(error),
      traceId,
    });
    return { byUserId: new Map(), failed: true };
  }
}

/**
 * Detalhe: um getUserById. Não atualiza last_sign_in do seller.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} traceId
 * @returns {Promise<{ at: string | null; failed: boolean }>}
 */
export async function carregarUltimoLoginAuthDoUsuario(supabase, userId, traceId) {
  const uid = String(userId || "").trim();
  if (!uid) return { at: null, failed: false };
  try {
    const { data, error } = await supabase.auth.admin.getUserById(uid);
    if (error) {
      console.warn("[dev-center-admin] auth_last_sign_in_detail_failed", {
        message: error.message,
        traceId,
      });
      return { at: null, failed: true };
    }
    return { at: apresentarInstanteAcesso(data?.user?.last_sign_in_at), failed: false };
  } catch (error) {
    console.warn("[dev-center-admin] auth_last_sign_in_detail_failed", {
      message: error instanceof Error ? error.message : String(error),
      traceId,
    });
    return { at: null, failed: true };
  }
}
