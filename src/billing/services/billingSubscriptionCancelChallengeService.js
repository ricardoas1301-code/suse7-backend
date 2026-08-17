// ======================================================================
// Desafio efêmero — confirmação consciente de cancelamento de assinatura
// ======================================================================

import crypto from "node:crypto";
import { recordBillingEvent } from "../billingEventService.js";
import { logBilling, logBillingError } from "../billingLog.js";

export const SUBSCRIPTION_CANCEL_CHALLENGE_ACTION = "cancel_subscription";
export const SUBSCRIPTION_CANCEL_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_CHALLENGES = 12;
const MAX_FAILED_ATTEMPTS = 5;

/**
 * @param {string} code
 * @param {string} message
 */
function buildChallengeError(code, message) {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  return err;
}

/**
 * @param {string} value
 */
function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/**
 * @param {unknown} payload
 */
function readChallengePayload(payload) {
  const raw = payload && typeof payload === "object" ? /** @type {Record<string, unknown>} */ (payload) : {};
  return {
    action: String(raw.action ?? ""),
    user_id: String(raw.user_id ?? ""),
    subscription_id: String(raw.subscription_id ?? ""),
    challenge_id: String(raw.challenge_id ?? ""),
    code_hash: String(raw.code_hash ?? ""),
    expires_at: String(raw.expires_at ?? ""),
    consumed_at: raw.consumed_at != null ? String(raw.consumed_at) : null,
  };
}

/**
 * Gera código numérico entre 1000 e 9999.
 */
export function generateSubscriptionCancelConfirmationCode() {
  return String(crypto.randomInt(1000, 10000));
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function countRecentChallenges(supabase, userId) {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("billing_events")
    .select("raw_payload, created_at")
    .eq("event_type", "SUBSCRIPTION_CANCEL_CHALLENGE_ISSUED")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((row) => String(row?.raw_payload?.user_id ?? "") === userId).length;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} challengeId
 */
async function countChallengeFailures(supabase, challengeId) {
  const { data, error } = await supabase
    .from("billing_events")
    .select("raw_payload")
    .eq("event_type", "SUBSCRIPTION_CANCEL_CHALLENGE_FAILED")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((row) => String(row?.raw_payload?.challenge_id ?? "") === challengeId).length;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} challengeId
 * @param {string} userId
 */
async function recordChallengeFailure(supabase, challengeId, userId) {
  try {
    await recordBillingEvent(supabase, {
      provider: "suse7",
      providerEventId: `cancel_challenge_fail:${challengeId}:${Date.now()}:${crypto.randomUUID()}`,
      eventType: "SUBSCRIPTION_CANCEL_CHALLENGE_FAILED",
      rawPayload: {
        action: SUBSCRIPTION_CANCEL_CHALLENGE_ACTION,
        user_id: userId,
        challenge_id: challengeId,
      },
    });
  } catch (error) {
    logBillingError("billing", "cancel_challenge_failure_event_failed", error, {
      user_id: userId,
      challenge_id: challengeId,
    });
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} challengeId
 */
async function isChallengeConsumed(supabase, challengeId) {
  const { data, error } = await supabase
    .from("billing_events")
    .select("id")
    .eq("provider_event_id", `cancel_challenge_used:${challengeId}`)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} subscriptionId
 */
export async function issueSubscriptionCancelChallenge(supabase, userId, subscriptionId) {
  const recent = await countRecentChallenges(supabase, userId);
  if (recent >= RATE_LIMIT_MAX_CHALLENGES) {
    throw buildChallengeError("SERVICE_UNAVAILABLE", "Muitas tentativas. Aguarde alguns minutos e tente novamente.");
  }

  const challengeId = crypto.randomUUID();
  const confirmationCode = generateSubscriptionCancelConfirmationCode();
  const expiresAt = new Date(Date.now() + SUBSCRIPTION_CANCEL_CHALLENGE_TTL_MS).toISOString();

  await recordBillingEvent(supabase, {
    provider: "suse7",
    providerEventId: `cancel_challenge:${challengeId}`,
    eventType: "SUBSCRIPTION_CANCEL_CHALLENGE_ISSUED",
    rawPayload: {
      action: SUBSCRIPTION_CANCEL_CHALLENGE_ACTION,
      user_id: userId,
      subscription_id: subscriptionId,
      challenge_id: challengeId,
      code_hash: hashSecret(confirmationCode),
      expires_at: expiresAt,
      consumed_at: null,
    },
  });

  logBilling("billing", "subscription_cancel_challenge_issued", {
    user_id: userId,
    subscription_id: subscriptionId,
    challenge_id: challengeId,
    expires_at: expiresAt,
  });

  return {
    challenge_id: challengeId,
    confirmation_code: confirmationCode,
    expires_at: expiresAt,
    expires_in: Math.floor(SUBSCRIPTION_CANCEL_CHALLENGE_TTL_MS / 1000),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} subscriptionId
 * @param {string} challengeId
 * @param {string} confirmationCode
 */
export async function consumeSubscriptionCancelChallenge(
  supabase,
  userId,
  subscriptionId,
  challengeId,
  confirmationCode,
) {
  const normalizedChallengeId = String(challengeId ?? "").trim();
  const normalizedCode =
    typeof confirmationCode === "string" ? confirmationCode.replace(/\D/g, "").slice(0, 4) : "";

  if (!normalizedChallengeId) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_INVALID", "Desafio de confirmação obrigatório.");
  }
  if (normalizedCode.length !== 4) {
    throw buildChallengeError("CONFIRMATION_CODE_INVALID", "O código informado não confere.");
  }

  const { data: issuedRow, error: issuedError } = await supabase
    .from("billing_events")
    .select("raw_payload")
    .eq("provider_event_id", `cancel_challenge:${normalizedChallengeId}`)
    .maybeSingle();
  if (issuedError) throw issuedError;

  const payload = readChallengePayload(issuedRow?.raw_payload);
  if (!payload.challenge_id) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_INVALID", "Desafio inválido ou expirado.");
  }
  if (payload.action !== SUBSCRIPTION_CANCEL_CHALLENGE_ACTION) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_INVALID", "Desafio inválido para esta ação.");
  }
  if (payload.user_id !== userId) {
    throw buildChallengeError("SUBSCRIPTION_FORBIDDEN", "Você não possui permissão para cancelar esta assinatura.");
  }
  if (payload.subscription_id !== subscriptionId) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_INVALID", "Desafio inválido para esta assinatura.");
  }

  const expiresMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_EXPIRED", "O código expirou. Um novo código foi gerado.");
  }

  if (await isChallengeConsumed(supabase, normalizedChallengeId)) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_REPLAYED", "Este código já foi utilizado.");
  }

  const failures = await countChallengeFailures(supabase, normalizedChallengeId);
  if (failures >= MAX_FAILED_ATTEMPTS) {
    throw buildChallengeError(
      "CONFIRMATION_CHALLENGE_INVALID",
      "Não foi possível validar a confirmação. Feche e abra o modal novamente.",
    );
  }

  if (hashSecret(normalizedCode) !== payload.code_hash) {
    await recordChallengeFailure(supabase, normalizedChallengeId, userId);
    const nextFailures = failures + 1;
    if (nextFailures >= MAX_FAILED_ATTEMPTS) {
      throw buildChallengeError(
        "CONFIRMATION_CHALLENGE_INVALID",
        "Não foi possível validar a confirmação. Feche e abra o modal novamente.",
      );
    }
    throw buildChallengeError("CONFIRMATION_CODE_INVALID", "O código informado não confere.");
  }

  const consumeResult = await recordBillingEvent(supabase, {
    provider: "suse7",
    providerEventId: `cancel_challenge_used:${normalizedChallengeId}`,
    eventType: "SUBSCRIPTION_CANCEL_CHALLENGE_CONSUMED",
    rawPayload: {
      action: SUBSCRIPTION_CANCEL_CHALLENGE_ACTION,
      user_id: userId,
      subscription_id: subscriptionId,
      challenge_id: normalizedChallengeId,
      consumed_at: new Date().toISOString(),
    },
  });

  if (consumeResult.duplicate) {
    throw buildChallengeError("CONFIRMATION_CHALLENGE_REPLAYED", "Este código já foi utilizado.");
  }

  return { challenge_id: normalizedChallengeId };
}
