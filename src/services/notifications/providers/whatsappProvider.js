// ============================================================
// Provider WhatsApp — Fase 2 (mock / stub para Twilio, Evolution, Meta, etc.)
// ============================================================

/**
 * @param {{
 *   destination: string,
 *   title: string,
 *   message: string,
 *   payload?: Record<string, unknown>,
 * }} args
 * @returns {Promise<{ success: boolean, providerMessageId?: string | null, raw?: unknown, permanentFailure?: boolean }>}
 */
export async function sendWhatsAppNotification(args) {
  const dest = String(args.destination ?? "").replace(/\D/g, "");
  if (!dest) {
    return { success: false, permanentFailure: true, raw: { reason: "missing_destination" } };
  }

  const mockId = `mock_wa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.info("[S7_NOTIFICATION][whatsapp_provider_mock]", {
    providerMessageId: mockId,
    destination_len: dest.length,
  });

  return {
    success: true,
    providerMessageId: mockId,
    raw: { mock: true },
  };
}
