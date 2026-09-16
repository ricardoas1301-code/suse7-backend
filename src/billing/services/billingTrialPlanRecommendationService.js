// ======================================================================
// Recomendação de plano no trial — pedidos do intervalo + catálogo
// ======================================================================

import { listActivePlans } from "./billingPlanRepository.js";
import { loadSellerEntitlementOverlay } from "./billingSellerEntitlementStoreService.js";
import { countSellerEcosystemSalesUsage } from "./subscriptionUsageMeter.js";
import { readSellerTrialState } from "./billingSellerTrialService.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import { lerChaveIntencaoComercial } from "./billingCommercialIntentService.js";
import { montarRecomendacaoPlanoTrial } from "../domain/recomendacaoPlanoTrial.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date }} [opcoes]
 */
export async function resolverRecomendacaoPlanoTrial(supabase, userId, opcoes = {}) {
  const now = opcoes.now instanceof Date ? opcoes.now : new Date();
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const trial = readSellerTrialState(overlay.metadata);
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const chosenPlanKey = lerChaveIntencaoComercial(overlay.metadata);
  const planos = await listActivePlans(supabase);

  const periodStart = trial.trial_start_date;
  const periodEnd = trial.trial_end_date;
  if (!periodStart || !periodEnd) {
    return montarRecomendacaoPlanoTrial({
      pedidosTrial: 0,
      planos,
      periodComplete: false,
      collectionComplete: false,
      chosenPlanKey,
    });
  }

  const periodComplete = Boolean(periodEnd && civilNow && civilNow > periodEnd);
  const windowEnd = periodComplete ? periodEnd : civilNow ?? periodEnd;

  const count = await countSellerEcosystemSalesUsage(supabase, userId, {
    period_start: periodStart,
    period_end: windowEnd,
  });

  return montarRecomendacaoPlanoTrial({
    pedidosTrial: count,
    planos,
    periodComplete,
    collectionComplete: true,
    chosenPlanKey,
  });
}
