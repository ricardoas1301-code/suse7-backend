// ======================================================================
// Bootstrap mínimo pós-login social — sem inventar dados comerciais.
// Não cria seller_companies, não aceita termos, não usa nome do provedor.
// ======================================================================

/** @param {import("@supabase/supabase-js").User} user */
function resolveSocialProvider(user) {
  const provider = String(user?.app_metadata?.provider ?? "").trim().toLowerCase();
  if (!provider || provider === "email") return null;
  return provider;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("@supabase/supabase-js").User} user
 */
export async function bootstrapSocialSessionOnce(supabase, user) {
  const userId = String(user?.id ?? "").trim();
  const provider = resolveSocialProvider(user);

  if (!userId) {
    return { ok: false, code: "INVALID_USER_ID", message: "Usuário inválido." };
  }
  if (!provider) {
    return { ok: false, code: "NOT_SOCIAL_PROVIDER", message: "Fluxo exclusivo para login social." };
  }

  const email = user.email != null ? String(user.email).trim().toLowerCase() : null;
  if (!email) {
    return { ok: false, code: "EMAIL_REQUIRED", message: "E-mail do provedor social ausente." };
  }

  const { data: existing, error: readErr } = await supabase
    .from("profiles")
    .select("id, email, nome, nome_loja")
    .eq("id", userId)
    .maybeSingle();

  if (readErr) {
    return {
      ok: false,
      code: "PROFILE_READ_FAILED",
      message: readErr.message ?? "Falha ao consultar perfil.",
    };
  }

  if (existing?.id) {
    return {
      ok: true,
      code: "ALREADY_BOOTSTRAPPED",
      idempotent: true,
      profile_created: false,
      company_created: false,
      provider,
    };
  }

  const now = new Date().toISOString();
  const { error: insertErr } = await supabase.from("profiles").insert({
    id: userId,
    email,
    nome: null,
    nome_loja: null,
    primeiro_login: true,
    created_at: now,
    last_login: now,
  });

  if (insertErr) {
    if (String(insertErr.code) === "23505") {
      return {
        ok: true,
        code: "ALREADY_BOOTSTRAPPED",
        idempotent: true,
        profile_created: false,
        company_created: false,
        provider,
      };
    }
    return {
      ok: false,
      code: "PROFILE_INSERT_FAILED",
      message: insertErr.message ?? "Não foi possível criar o perfil mínimo.",
    };
  }

  return {
    ok: true,
    code: "BOOTSTRAPPED",
    idempotent: false,
    profile_created: true,
    company_created: false,
    provider,
  };
}
