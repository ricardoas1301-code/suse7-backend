// =============================================================================
// Validação e normalização — destinatários (Fase 3.2.1)
// =============================================================================

import { S7_NOTIFICATION_CHANNEL, isValidNotificationChannel } from "../constants/channels.js";

export const RECIPIENT_ERROR = Object.freeze({
  DUPLICATE_RECIPIENT: "DUPLICATE_RECIPIENT",
  INVALID_RECIPIENT_DESTINATION: "INVALID_RECIPIENT_DESTINATION",
  INVALID_CHANNEL: "INVALID_CHANNEL",
});

/** Canais permitidos para destinatários seller (sem in_app/push) */
const RECIPIENT_CHANNELS = new Set([
  S7_NOTIFICATION_CHANNEL.EMAIL,
  S7_NOTIFICATION_CHANNEL.WHATSAPP,
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WHATSAPP_MIN_DIGITS = 10;
const WHATSAPP_MAX_DIGITS = 15;

/**
 * @param {string} channel
 * @param {unknown} rawDestination
 * @returns {{ ok: true, channel: string, destination: string } | { ok: false, error: string, message: string }}
 */
export function normalizeAndValidateRecipientDestination(channel, rawDestination) {
  const ch = String(channel ?? "").trim();

  if (!isValidNotificationChannel(ch) || !RECIPIENT_CHANNELS.has(ch)) {
    return {
      ok: false,
      error: RECIPIENT_ERROR.INVALID_CHANNEL,
      message: "Canal inválido. Use e-mail ou WhatsApp.",
    };
  }

  if (rawDestination == null || String(rawDestination).trim() === "") {
    return {
      ok: false,
      error: RECIPIENT_ERROR.INVALID_RECIPIENT_DESTINATION,
      message: "Destino é obrigatório.",
    };
  }

  if (ch === S7_NOTIFICATION_CHANNEL.EMAIL) {
    const email = String(rawDestination).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return {
        ok: false,
        error: RECIPIENT_ERROR.INVALID_RECIPIENT_DESTINATION,
        message: "E-mail inválido.",
      };
    }
    return { ok: true, channel: ch, destination: email };
  }

  const digits = String(rawDestination).replace(/\D/g, "");
  if (digits.length < WHATSAPP_MIN_DIGITS || digits.length > WHATSAPP_MAX_DIGITS) {
    return {
      ok: false,
      error: RECIPIENT_ERROR.INVALID_RECIPIENT_DESTINATION,
      message: `WhatsApp inválido. Informe entre ${WHATSAPP_MIN_DIGITS} e ${WHATSAPP_MAX_DIGITS} dígitos.`,
    };
  }

  return { ok: true, channel: ch, destination: digits };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} channel
 * @param {string} destination
 * @param {string | null} [excludeRecipientId]
 */
/**
 * @param {string} channel
 */
export function buildDuplicateRecipientError(channel) {
  const ch = String(channel ?? "").trim();
  const duplicated_field =
    ch === S7_NOTIFICATION_CHANNEL.EMAIL ? "email" : "whatsapp";
  const message =
    duplicated_field === "email"
      ? "E-mail já cadastrado em outro destinatário."
      : "WhatsApp já cadastrado em outro destinatário.";
  return {
    ok: false,
    error: RECIPIENT_ERROR.DUPLICATE_RECIPIENT,
    duplicated_field,
    message,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} channel
 * @param {string} destination
 * @param {string | null} [excludeRecipientId]
 */
export async function findDuplicateRecipientSlot(supabase, sellerId, channel, destination, excludeRecipientId) {
  let q = supabase
    .from("s7_notification_recipients")
    .select("id, is_active")
    .eq("seller_id", sellerId)
    .eq("channel", channel)
    .eq("destination", destination);

  if (excludeRecipientId) {
    q = q.neq("id", excludeRecipientId);
  }

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data?.id != null ? { id: String(data.id), is_active: Boolean(data.is_active) } : null;
}
