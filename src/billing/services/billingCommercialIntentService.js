// ======================================================================
// Persistência da intenção comercial — overlay, sem ativar plano pago
// ======================================================================

import { BILLING_COMMERCIAL_INTENT_SOURCE, BILLING_TRIAL_METADATA_KEYS } from "../billingConstants.js";
import { listActivePlans } from "./billingPlanRepository.js";
import { resolverIntencaoComercialNoCatalogo } from "../domain/intencaoComercialPlano.js";
import {
  ensureSellerEntitlementOverlay,
  patchSellerEntitlementOverlayMetadata,
} from "./billingSellerEntitlementStoreService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {unknown} chaveBruta
 */
export async function validarChaveIntencaoComercial(supabase, chaveBruta) {
  const planos = await listActivePlans(supabase);
  return resolverIntencaoComercialNoCatalogo(chaveBruta, planos);
}

/**
 * Grava só a chave validada no overlay. Não inicia cobrança nem troca o plano efetivo.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {unknown} chaveBruta
 * @param {{ source?: string; now?: Date }} [opcoes]
 */
export async function persistirIntencaoComercialPlano(supabase, userId, chaveBruta, opcoes = {}) {
  const validacao = await validarChaveIntencaoComercial(supabase, chaveBruta);
  if (!validacao.ok) {
    return { persisted: false, reason: validacao.reason, plan_key: null };
  }

  const overlay = await ensureSellerEntitlementOverlay(supabase, userId);
  if (!overlay.overlay_id) {
    return { persisted: false, reason: "overlay_missing", plan_key: validacao.plan_key };
  }

  const atual = overlay.metadata?.[BILLING_TRIAL_METADATA_KEYS.COMMERCIAL_INTENT_PLAN_KEY];
  if (String(atual ?? "") === validacao.plan_key) {
    return { persisted: false, reason: "already_set", plan_key: validacao.plan_key, idempotent: true };
  }

  const agora = opcoes.now instanceof Date ? opcoes.now : new Date();
  await patchSellerEntitlementOverlayMetadata(
    supabase,
    overlay.overlay_id,
    overlay.metadata,
    {
      [BILLING_TRIAL_METADATA_KEYS.COMMERCIAL_INTENT_PLAN_KEY]: validacao.plan_key,
      [BILLING_TRIAL_METADATA_KEYS.COMMERCIAL_INTENT_SOURCE]:
        opcoes.source ?? BILLING_COMMERCIAL_INTENT_SOURCE.PUBLIC_PLANS_SIGNUP,
      [BILLING_TRIAL_METADATA_KEYS.COMMERCIAL_INTENT_RECORDED_AT]: agora.toISOString(),
    },
    { source: "commercial_plan_intent", idempotency_key: `intent:${userId}:${validacao.plan_key}` }
  );

  return { persisted: true, plan_key: validacao.plan_key };
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function lerChaveIntencaoComercial(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const chave = meta[BILLING_TRIAL_METADATA_KEYS.COMMERCIAL_INTENT_PLAN_KEY];
  return typeof chave === "string" && chave.trim() ? chave.trim().toLowerCase() : null;
}
