// =============================================================================
// S7 — Canal WhatsApp (Fase S5.6) — política multi-destinatário
// Formaliza o suporte existente sem alterar UX nem fluxo Raio-X.
// =============================================================================

import {
  dedupeManualRayxRecipientTargets,
  normalizeBrazilWhatsAppPhone,
} from "../sales/manualSaleRayxRecipientTargets.js";

/** Estratégias de deduplicação documentadas. */
export const S7_WHATSAPP_MULTI_RECIPIENT_DEDUPE = Object.freeze({
  BY_NORMALIZED_PHONE: "by_normalized_phone_br",
  BLOCK_TEST_PHONES: "block_smoke_and_sandbox_test_phones",
  DISPATCH_SLOT: "dispatch_slot_per_channel_recipient_destination",
});

/**
 * Descreve a política oficial multi-destinatário (metadados, sem regra de negócio nova).
 */
export function describeWhatsAppMultiRecipientPolicy() {
  return {
    supports_single: true,
    supports_multiple: true,
    normalization: "normalizeBrazilWhatsAppPhone (E.164 sem +, DDI 55)",
    dedupe_strategies: Object.values(S7_WHATSAPP_MULTI_RECIPIENT_DEDUPE),
    motor_central: {
      note: "Um dispatch por slot (channel + recipient_id + destination); duplicata ignorada no Actions Engine.",
      table: "s7_notification_dispatches",
    },
    manual_rayx: {
      note: "Batch Raio-X deduplica telefones antes de publicar eventos; preserva UX atual.",
      function: "dedupeManualRayxRecipientTargets",
    },
  };
}

/**
 * Wrapper oficial — delega à implementação homologada do Raio-X.
 * @param {Parameters<typeof dedupeManualRayxRecipientTargets>[0]} rawTargets
 * @param {Parameters<typeof dedupeManualRayxRecipientTargets>[1]} [options]
 */
export function dedupeOfficialWhatsAppRecipients(rawTargets, options) {
  return dedupeManualRayxRecipientTargets(rawTargets, options);
}

export { normalizeBrazilWhatsAppPhone, dedupeManualRayxRecipientTargets };
