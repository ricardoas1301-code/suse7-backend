// ======================================================================
// Carrega contexto onboarding — uma ida ao banco por entidade (sem N+1)
// ======================================================================

const PROFILE_ONBOARDING_SELECT =
  "id, email, telefone, operational_day_closes_at, operational_working_days, operational_cycle_configured_at, first_marketplace_connected_at, initial_configuration_completed_at";

/** Pré-migration 01B — colunas latch ainda ausentes no hosted. */
const PROFILE_ONBOARDING_SELECT_LEGACY =
  "id, email, telefone, operational_day_closes_at, operational_working_days";

const COMPANY_ONBOARDING_SELECT =
  "id, user_id, company_name, trade_name, document_cnpj, contact_email, whatsapp, phone, default_tax_rate, operational_cost_rate, is_primary, active";

/**
 * @param {{ code?: string; message?: string } | null | undefined} error
 */
function isMissingOnboardingLatchColumnError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();
  if (code === "42703" || code === "PGRST204") return true;
  return (
    message.includes("operational_cycle_configured_at") ||
    message.includes("first_marketplace_connected_at") ||
    message.includes("initial_configuration_completed_at")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function carregarProfileOnboarding(supabase, userId) {
  const full = await supabase
    .from("profiles")
    .select(PROFILE_ONBOARDING_SELECT)
    .eq("id", userId)
    .maybeSingle();

  if (!full.error) {
    return { data: full.data, error: null, latch_columns_available: true };
  }

  if (!isMissingOnboardingLatchColumnError(full.error)) {
    return { data: null, error: full.error, latch_columns_available: false };
  }

  const legacy = await supabase
    .from("profiles")
    .select(PROFILE_ONBOARDING_SELECT_LEGACY)
    .eq("id", userId)
    .maybeSingle();

  if (legacy.error) {
    return { data: null, error: legacy.error, latch_columns_available: false };
  }

  return {
    data: {
      ...(legacy.data ?? {}),
      operational_cycle_configured_at: null,
      first_marketplace_connected_at: null,
      initial_configuration_completed_at: null,
    },
    error: null,
    latch_columns_available: false,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function carregarContasMarketplaceOnboarding(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return [];

  const selectVariants = [
    "id, marketplace, status, seller_company_id, external_seller_id, user_id",
    "id, marketplace, status, seller_company_id, user_id",
    "id, marketplace, status, user_id",
  ];

  for (const sel of selectVariants) {
    const { data, error } = await supabase.from("marketplace_accounts").select(sel).eq("user_id", uid);
    if (!error) return Array.isArray(data) ? data : [];
    const msg = String(error.message ?? "").toLowerCase();
    if (String(error.code ?? "") === "42703" || msg.includes("column")) continue;
    return [];
  }

  return [];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function carregarContextoConfiguracaoInicial(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return { ok: false, code: "INVALID_USER", profile: null, companies: [], legalAcceptance: null };
  }

  const [profileRes, companiesRes, legalRes, marketplaceAccountsRes] = await Promise.all([
    carregarProfileOnboarding(supabase, uid),
    supabase.from("seller_companies").select(COMPANY_ONBOARDING_SELECT).eq("user_id", uid),
    supabase
      .from("legal_document_acceptances")
      .select("document_type, document_version, document_hash, scrolled_to_end, accepted_at")
      .eq("user_id", uid)
      .eq("document_type", "TERMS_OF_USE")
      .order("accepted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    carregarContasMarketplaceOnboarding(supabase, uid),
  ]);

  if (profileRes.error) {
    return {
      ok: false,
      code: "PROFILE_LOAD_ERROR",
      error: profileRes.error,
      profile: null,
      companies: [],
      legalAcceptance: null,
    };
  }

  if (companiesRes.error) {
    return {
      ok: false,
      code: "COMPANIES_LOAD_ERROR",
      error: companiesRes.error,
      profile: profileRes.data,
      companies: [],
      legalAcceptance: null,
    };
  }

  if (legalRes.error) {
    return {
      ok: false,
      code: "LEGAL_LOAD_ERROR",
      error: legalRes.error,
      profile: profileRes.data,
      companies: companiesRes.data ?? [],
      legalAcceptance: null,
    };
  }

  return {
    ok: true,
    profile: profileRes.data ?? null,
    companies: companiesRes.data ?? [],
    legalAcceptance: legalRes.data ?? null,
    marketplaceAccounts: marketplaceAccountsRes ?? [],
    latch_columns_available: profileRes.latch_columns_available === true,
  };
}
