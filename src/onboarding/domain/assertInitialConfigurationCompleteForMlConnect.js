// ======================================================================
// Gate M1–M5 — primeira conexão onboarding (autoridade canônica snapshot).
// ======================================================================

import { carregarContextoConfiguracaoInicial } from "../../onboarding/services/carregarContextoConfiguracaoInicial.js";
import { resolveConfigurationSnapshot } from "./resolverSnapshotConfiguracaoInicial.js";
import { CONFIGURATION_STATUS, MILESTONE_IDS, MILESTONE_STATUS } from "./milestonesConfiguracaoInicial.js";

const REQUIRED_MILESTONE_IDS = [
  MILESTONE_IDS.COMPANY_DATA,
  MILESTONE_IDS.LEGAL_ACCEPTANCE,
  MILESTONE_IDS.TAX_RATE,
  MILESTONE_IDS.OPERATIONAL_COST,
  MILESTONE_IDS.OPERATIONAL_CYCLE,
];

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ ok: true } | { ok: false; code: string; message: string; incomplete_milestones?: string[] }>}
 */
export async function assertInitialConfigurationCompleteForMlConnect(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return { ok: false, code: "invalid_user", message: "Usuário inválido." };
  }

  const ctx = await carregarContextoConfiguracaoInicial(supabase, uid);
  const snapshot = resolveConfigurationSnapshot({
    profile: ctx.profile ?? null,
    companies: ctx.companies ?? [],
    legalAcceptance: ctx.legalAcceptance ?? null,
  });

  if (snapshot.configuration.status === CONFIGURATION_STATUS.COMPLETED) {
    return { ok: true };
  }

  const milestones = Array.isArray(snapshot.milestones) ? snapshot.milestones : [];
  /** @type {string[]} */
  const incomplete = [];
  for (const id of REQUIRED_MILESTONE_IDS) {
    const row = milestones.find((m) => String(m?.id ?? "") === id);
    if (!row || row.status !== MILESTONE_STATUS.COMPLETED) {
      incomplete.push(id);
    }
  }

  if (incomplete.length > 0) {
    return {
      ok: false,
      code: "initial_configuration_incomplete",
      message: "Conclua a configuração inicial antes de conectar o marketplace.",
      incomplete_milestones: incomplete,
    };
  }

  return { ok: true };
}
