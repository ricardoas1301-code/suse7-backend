// =============================================================================
// Destinatários manual Raio-X — normalização BR + dedupe (S_3.5C.1.A4.5)
// =============================================================================

import { config } from "../../../../infra/config.js";
import { getWhatsAppSandboxWhitelist } from "../whatsapp/whatsappSandboxPolicy.js";
/**
 * @param {boolean | string | number | null | undefined} raw
 */
function isExplicitSmokeDestinationRequest(raw) {
  if (raw === true || raw === 1) return true;
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * Normaliza telefone BR para comparação/envio (E.164 sem +, com DDI 55).
 * @param {string} raw
 */
export function normalizeBrazilWhatsAppPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  while (digits.startsWith("0") && digits.length > 11) {
    digits = digits.slice(1);
  }
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith("55")) {
    digits = `55${digits}`;
  }
  return digits;
}

function readSmokePhoneDigits() {
  const fromEnv = process.env.S7_PROVIDER_SMOKE_PHONE;
  const fromConfig = config.s7ProviderSmokePhone;
  const raw =
    fromEnv != null && String(fromEnv).trim() !== "" ? String(fromEnv).trim() : String(fromConfig ?? "");
  return normalizeBrazilWhatsAppPhone(raw);
}

/**
 * Telefones de teste que não podem entrar como destinatário real.
 * @param {{ useSmokeDestination?: boolean }} options
 * @returns {Set<string>}
 */
export function getManualRayxBlockedTestPhones(options = {}) {
  const blocked = new Set();
  if (isExplicitSmokeDestinationRequest(options.useSmokeDestination)) {
    return blocked;
  }
  const smoke = readSmokePhoneDigits();
  if (smoke) blocked.add(smoke);
  for (const entry of getWhatsAppSandboxWhitelist()) {
    const normalized = normalizeBrazilWhatsAppPhone(entry);
    if (normalized) blocked.add(normalized);
  }
  return blocked;
}

/**
 * @param {Array<{ recipientId?: string | null; recipientPhone?: string | null; label?: string }>} rawTargets
 * @param {{ useSmokeDestination?: boolean; channel?: string; saleId?: string }} options
 */
export function dedupeManualRayxRecipientTargets(rawTargets, options = {}) {
  const channel = String(options.channel ?? "whatsapp").toLowerCase();
  const blockedTestPhones = getManualRayxBlockedTestPhones(options);

  const selectedRecipientIdsRaw = [];
  const selectedRecipientPhonesRaw = [];
  /** @type {Array<{ recipientId: string | null; recipientPhone: string; label?: string }>} */
  const finalRecipientTargets = [];
  /** @type {Array<Record<string, unknown>>} */
  const duplicateRecipientsRemoved = [];

  /** @type {Map<string, { recipientId: string | null; recipientPhone: string; label?: string }>} */
  const byNormalizedPhone = new Map();

  for (const entry of rawTargets ?? []) {
    const rawPhone = String(entry?.recipientPhone ?? "").replace(/\D/g, "");
    const recipientId = entry?.recipientId != null ? String(entry.recipientId) : null;
    selectedRecipientPhonesRaw.push(rawPhone);
    selectedRecipientIdsRaw.push(recipientId);

    const normalized = normalizeBrazilWhatsAppPhone(rawPhone);
    if (!normalized || normalized.length < 12 || normalized.length > 15) {
      duplicateRecipientsRemoved.push({
        recipient_id: recipientId,
        recipient_phone_raw: rawPhone,
        reason: "INVALID_PHONE",
      });
      continue;
    }

    if (blockedTestPhones.has(normalized)) {
      duplicateRecipientsRemoved.push({
        recipient_id: recipientId,
        recipient_phone_raw: rawPhone,
        recipient_phone_normalized: normalized,
        reason: "BLOCKED_TEST_OR_SMOKE_PHONE",
      });
      continue;
    }

    const dedupeKey = `${options.saleId ?? ""}:${channel}:${normalized}`;
    const existing = byNormalizedPhone.get(dedupeKey);
    if (existing) {
      duplicateRecipientsRemoved.push({
        recipient_id: recipientId,
        recipient_phone_raw: rawPhone,
        recipient_phone_normalized: normalized,
        kept_recipient_id: existing.recipientId,
        reason: "DUPLICATE_NORMALIZED_PHONE",
      });
      continue;
    }

    const target = {
      recipientId,
      recipientPhone: normalized,
      label: entry?.label,
    };
    byNormalizedPhone.set(dedupeKey, target);
    finalRecipientTargets.push(target);
  }

  const selectedRecipientPhonesNormalized = finalRecipientTargets.map((t) => t.recipientPhone);

  return {
    selected_recipient_ids_raw: selectedRecipientIdsRaw,
    selected_recipient_phones_raw: selectedRecipientPhonesRaw,
    selected_recipient_phones_normalized: selectedRecipientPhonesNormalized,
    duplicate_recipients_removed: duplicateRecipientsRemoved,
    final_recipient_targets: finalRecipientTargets,
    dispatches_planned: finalRecipientTargets.length,
  };
}
