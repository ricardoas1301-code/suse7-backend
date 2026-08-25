// ======================================================================
// resolveConfigurationSnapshot — projeção canônica (sem I/O, sem writes)
// ======================================================================

import {
  projetarPercentualConfiguracao,
  TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO,
} from "./escopoConfiguracaoInicial.js";
import {
  CONFIGURATION_STATUS,
  MILESTONE_IDS,
  MILESTONE_ORDER,
  MILESTONE_STATUS,
  milestoneBloqueiaConfiguracaoInicial,
} from "./milestonesConfiguracaoInicial.js";
import {
  montarAcaoNavegacaoMarketplace,
  MARKETPLACE_PROVIDER_ONBOARDING_INICIAL,
} from "./contratoNavegacaoMarketplace.js";
import {
  auditarAssimetriaTelefone,
  avaliarMilestoneAceiteJuridico,
  avaliarMilestoneAliquotaImposto,
  avaliarMilestoneCustoOperacional,
  avaliarMilestoneCicloOperacional,
  avaliarMilestoneDadosEmpresa,
  avaliarMilestonePrimeiraIntegracaoMarketplace,
  dependenciaM1ParaM6,
  resolverEmpresaPrincipalOnboarding,
} from "./avaliarMilestonesConfiguracaoInicial.js";

/**
 * @typedef {{
 *   profile: Record<string, unknown> | null;
 *   companies: readonly Record<string, unknown>[];
 *   legalAcceptance: Record<string, unknown> | null;
 * }} ContextoConfiguracaoInicial
 */

/**
 * @param {ContextoConfiguracaoInicial} ctx
 */
export function resolveConfigurationSnapshot(ctx) {
  const profile = ctx?.profile ?? null;
  const companies = ctx?.companies ?? [];
  const legalAcceptance = ctx?.legalAcceptance ?? null;

  const { company: primaryCompany, ambiguous: companyAmbiguous, reason: companyReason } =
    resolverEmpresaPrincipalOnboarding(companies);

  const m1Eval = companyAmbiguous
    ? { completed: false, reason: companyReason ?? "COMPANY_AMBIGUOUS" }
    : avaliarMilestoneDadosEmpresa(primaryCompany);

  const phoneAudit = auditarAssimetriaTelefone(profile, primaryCompany);

  const evaluators = {
    [MILESTONE_IDS.COMPANY_DATA]: m1Eval,
    [MILESTONE_IDS.LEGAL_ACCEPTANCE]: avaliarMilestoneAceiteJuridico(legalAcceptance),
    [MILESTONE_IDS.TAX_RATE]: avaliarMilestoneAliquotaImposto(primaryCompany),
    [MILESTONE_IDS.OPERATIONAL_COST]: avaliarMilestoneCustoOperacional(primaryCompany),
    [MILESTONE_IDS.OPERATIONAL_CYCLE]: avaliarMilestoneCicloOperacional(profile),
    [MILESTONE_IDS.FIRST_MARKETPLACE_CONNECTION]: avaliarMilestonePrimeiraIntegracaoMarketplace(profile),
  };

  const latchedComplete =
    profile?.initial_configuration_completed_at != null &&
    String(profile.initial_configuration_completed_at).trim() !== "";

  /** @type {Record<string, { id: string; status: string; required: boolean; action?: object; dependency?: object }>} */
  const milestoneMap = {};

  for (const id of MILESTONE_ORDER) {
    const evaluation = evaluators[id];
    const isBlocking = milestoneBloqueiaConfiguracaoInicial(id);
    const status =
      latchedComplete || evaluation.completed
        ? MILESTONE_STATUS.COMPLETED
        : MILESTONE_STATUS.PENDING;

    /** @type {{ id: string; status: string; required: boolean; action?: object; dependency?: object }} */
    const item = {
      id,
      status,
      required: isBlocking,
    };

    if (id === MILESTONE_IDS.FIRST_MARKETPLACE_CONNECTION) {
      item.action = montarAcaoNavegacaoMarketplace(MARKETPLACE_PROVIDER_ONBOARDING_INICIAL);
      item.dependency = dependenciaM1ParaM6(m1Eval);
    }

    milestoneMap[id] = item;
  }

  const milestones = MILESTONE_ORDER.map((id) => milestoneMap[id]);

  const blockingMilestones = milestones.filter((m) => m.required);
  const blockingCompletedCount = latchedComplete
    ? TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO
    : blockingMilestones.filter((m) => m.status === MILESTONE_STATUS.COMPLETED).length;

  const configurationStatus = latchedComplete
    ? CONFIGURATION_STATUS.COMPLETED
    : blockingCompletedCount >= TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO
      ? CONFIGURATION_STATUS.COMPLETED
      : CONFIGURATION_STATUS.IN_PROGRESS;

  const percent = latchedComplete
    ? 100
    : projetarPercentualConfiguracao(
        blockingCompletedCount,
        TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO,
      );

  return {
    ok: true,
    configuration: {
      status: configurationStatus,
      completed: blockingCompletedCount,
      total: TOTAL_MILESTONES_BLOQUEANTES_CONFIGURACAO,
      percent,
      completed_at: latchedComplete ? profile?.initial_configuration_completed_at ?? null : null,
    },
    milestones,
    authorities: {
      user_id: profile?.id ?? null,
      primary_seller_company_id: primaryCompany?.id ?? null,
      company_resolution: companyAmbiguous ? "AMBIGUOUS_FAIL_CLOSED" : primaryCompany ? "RESOLVED" : "MISSING",
      phone_audit: phoneAudit,
    },
    dependencies: {
      m1_to_m6: dependenciaM1ParaM6(m1Eval),
    },
  };
}

/**
 * Latch monotônico ao completar milestones bloqueantes (M1–M5).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {ReturnType<typeof resolveConfigurationSnapshot>} snapshot
 */
export async function tentarRegistrarConclusaoConfiguracaoInicial(supabase, userId, snapshot) {
  const uid = String(userId || "").trim();
  if (!uid) return { updated: false, reason: "INVALID_USER" };
  if (snapshot.configuration.status !== CONFIGURATION_STATUS.COMPLETED) {
    return { updated: false, reason: "NOT_ALL_MILESTONES_COMPLETE" };
  }
  if (snapshot.configuration.completed_at) {
    return { updated: false, reason: "ALREADY_LATCHED" };
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("profiles")
    .update({ initial_configuration_completed_at: now })
    .eq("id", uid)
    .is("initial_configuration_completed_at", null)
    .select("initial_configuration_completed_at")
    .maybeSingle();

  if (error) return { updated: false, reason: "PERSISTENCE_ERROR", error };
  return {
    updated: Boolean(data?.initial_configuration_completed_at),
    latched_at: data?.initial_configuration_completed_at ?? now,
  };
}
