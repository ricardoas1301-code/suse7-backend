// ======================================================================
// Fronteira única: trial_ends_at_exclusive (S1.HF.6.9A.11A)
// Nenhum resolver do domínio deve consumir o timestamp legado diretamente.
// ======================================================================

import {
  addBillingCivilDays,
  formatBillingCivilDateInSaoPaulo,
  parseBillingCivilDate,
} from "./billingCycleService.js";
import { civilDateStartInstantSaoPaulo } from "./billingCivilCycleWindowService.js";
import { resolveTrialDurationDays } from "./billingTrialConfigService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Deriva data civil America/Sao_Paulo a partir de um instante.
 *
 * @param {Date} instant
 */
export function civilDateFromInstantSaoPaulo(instant) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;
  return formatBillingCivilDateInSaoPaulo(instant);
}

/**
 * Instante exclusivo = 00:00 SP do dia civil seguinte ao fim inclusivo.
 *
 * @param {string} trialEndCivilInclusive
 * @returns {Date | null}
 */
export function exclusiveInstantFromEndCivil(trialEndCivilInclusive) {
  const end = parseBillingCivilDate(trialEndCivilInclusive);
  if (!end) return null;
  const next = addBillingCivilDays(end, 1);
  return next ? civilDateStartInstantSaoPaulo(next) : null;
}

/**
 * Normaliza qualquer entrada legada/canônica para o relógio exclusivo único.
 *
 * Entradas aceitas:
 * - trial_end_date civil (preferencial)
 * - trial_extended_end_date civil
 * - trial_ends_at exclusivo ISO
 * - trial_ends_at legado fim de dia (23:59:59.999)
 * - trial_started_at / trial_start_date + duration
 *
 * @param {{
 *   trial_end_date?: unknown;
 *   trial_extended_end_date?: unknown;
 *   trial_ends_at?: unknown;
 *   trial_start_date?: unknown;
 *   trial_started_at?: unknown;
 *   duration_days?: number | null;
 * }} input
 */
export function normalizeTrialEndsAtExclusive(input = {}) {
  const extended = parseBillingCivilDate(input.trial_extended_end_date);
  const endCivilDirect = parseBillingCivilDate(input.trial_end_date);
  let endCivil = extended ?? endCivilDirect;

  const rawEndsAt = asTrimmedString(input.trial_ends_at);
  /** @type {Date | null} */
  let parsedEndsAt = null;
  if (rawEndsAt) {
    const d = new Date(rawEndsAt);
    if (!Number.isNaN(d.getTime())) parsedEndsAt = d;
  }

  // Sem end civil: tentar derivar de start + duration.
  if (!endCivil) {
    const startCivil =
      parseBillingCivilDate(input.trial_start_date) ??
      (input.trial_started_at
        ? civilDateFromInstantSaoPaulo(
            input.trial_started_at instanceof Date
              ? input.trial_started_at
              : new Date(String(input.trial_started_at)),
          )
        : null);
    if (startCivil) {
      const duration =
        Number.isFinite(Number(input.duration_days)) && Number(input.duration_days) > 0
          ? Number(input.duration_days)
          : resolveTrialDurationDays();
      // Inclusivo: start + (duration - 1) dias civis.
      endCivil = addBillingCivilDays(startCivil, Math.max(0, duration - 1));
    }
  }

  // Legado fim fechado / exclusivo ISO sem civil: civil = dia SP do instante.
  // Se o instante for exatamente 00:00 SP de um dia D, trata como exclusive de (D-1)
  // somente quando NÃO houver civil canônico — e o exclusive resultante é o próprio instante.
  if (!endCivil && parsedEndsAt) {
    const civilOfInstant = civilDateFromInstantSaoPaulo(parsedEndsAt);
    if (!civilOfInstant) {
      return {
        ok: false,
        error: "invalid_trial_ends_at",
        trial_end_date: null,
        trial_ends_at_exclusive: null,
        trial_ends_at_exclusive_iso: null,
        source: null,
      };
    }
    const startOfThatCivil = civilDateStartInstantSaoPaulo(civilOfInstant);
    const isExactStart =
      startOfThatCivil instanceof Date &&
      startOfThatCivil.getTime() === parsedEndsAt.getTime();
    if (isExactStart) {
      // Já é exclusive canônico do dia anterior.
      const prev = addBillingCivilDays(civilOfInstant, -1);
      return {
        ok: Boolean(prev),
        error: prev ? null : "invalid_exclusive_anchor",
        trial_end_date: prev,
        trial_ends_at_exclusive: parsedEndsAt,
        trial_ends_at_exclusive_iso: parsedEndsAt.toISOString(),
        source: "exclusive_instant",
      };
    }
    // Fim fechado legado (ex.: 23:59:59.999) → civil = dia do instante; exclusive = next day.
    endCivil = civilOfInstant;
  }

  if (!endCivil) {
    return {
      ok: false,
      error: "trial_end_missing_or_invalid",
      trial_end_date: null,
      trial_ends_at_exclusive: null,
      trial_ends_at_exclusive_iso: null,
      source: null,
    };
  }

  const exclusive = exclusiveInstantFromEndCivil(endCivil);
  if (!(exclusive instanceof Date) || Number.isNaN(exclusive.getTime())) {
    return {
      ok: false,
      error: "exclusive_compute_failed",
      trial_end_date: endCivil,
      trial_ends_at_exclusive: null,
      trial_ends_at_exclusive_iso: null,
      source: null,
    };
  }

  return {
    ok: true,
    error: null,
    trial_end_date: endCivil,
    trial_ends_at_exclusive: exclusive,
    trial_ends_at_exclusive_iso: exclusive.toISOString(),
    source: extended
      ? "trial_extended_end_date"
      : endCivilDirect
        ? "trial_end_date"
        : rawEndsAt
          ? "legacy_or_instant"
          : "start_plus_duration",
  };
}
