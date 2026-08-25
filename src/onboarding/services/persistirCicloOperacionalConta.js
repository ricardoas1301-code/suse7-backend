// ======================================================================
// Confirmação explícita do ciclo operacional — latch monotônico (M5)
// ======================================================================

import { validarPayloadConfirmacaoCicloOperacional } from "../domain/cicloOperacionalConta.js";

/**
 * Persiste horário, dias e latch de confirmação de forma atômica (single UPDATE).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} payload
 */
export async function persistirCicloOperacionalConta(supabase, userId, payload) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return { ok: false, code: "INVALID_USER", message: "Usuário inválido." };
  }

  const validation = validarPayloadConfirmacaoCicloOperacional(payload);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code,
      message: validation.message,
    };
  }

  const { data: existing, error: loadError } = await supabase
    .from("profiles")
    .select("operational_cycle_configured_at")
    .eq("id", uid)
    .maybeSingle();

  if (loadError) {
    return {
      ok: false,
      code: "LOAD_FAILED",
      message: "Não foi possível carregar o perfil.",
    };
  }

  const configuredAt =
    existing?.operational_cycle_configured_at != null &&
    String(existing.operational_cycle_configured_at).trim() !== ""
      ? existing.operational_cycle_configured_at
      : new Date().toISOString();

  const { data, error } = await supabase
    .from("profiles")
    .update({
      operational_day_closes_at: validation.closesAt,
      operational_working_days: validation.workingDays,
      operational_cycle_configured_at: configuredAt,
    })
    .eq("id", uid)
    .select("operational_day_closes_at, operational_working_days, operational_cycle_configured_at")
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      code: "PERSISTENCE_ERROR",
      message: error.message || "Não foi possível salvar a configuração operacional.",
    };
  }

  return {
    ok: true,
    profile: data,
    configured_at: configuredAt,
    first_confirmation: existing?.operational_cycle_configured_at == null,
  };
}
