// ======================================================================
// Logo da empresa principal — SSOT para header/layout (schema-tolerant)
// ======================================================================

import { resolverEmpresaPrincipalOnboarding } from "../../onboarding/domain/avaliarMilestonesConfiguracaoInicial.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
export async function carregarLogoUrlEmpresaPrincipal(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return null;

  const selectVariants = [
    "id, user_id, logo_url, is_primary, active, created_at",
    "id, user_id, logo_url, is_primary, created_at",
    "id, user_id, logo_url, created_at",
    "id, user_id, logo_url",
  ];

  for (const sel of selectVariants) {
    const { data, error } = await supabase.from("seller_companies").select(sel).eq("user_id", uid);
    if (error) {
      const msg = String(error.message ?? "").toLowerCase();
      if (String(error.code ?? "") === "42703" || msg.includes("column") || msg.includes("does not exist")) {
        continue;
      }
      return null;
    }

    const { company } = resolverEmpresaPrincipalOnboarding(Array.isArray(data) ? data : []);
    const logo = company?.logo_url != null ? String(company.logo_url).trim() : "";
    if (logo) return logo;
    return null;
  }

  return null;
}
