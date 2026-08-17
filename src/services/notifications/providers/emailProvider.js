// ============================================================
// Provider E-mail — Fase 2 (mock / stub para Resend, SES, SendGrid…)
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
export async function sendEmailNotification(args) {
  const dest = String(args.destination ?? "").trim().toLowerCase();
  if (!dest || !dest.includes("@")) {
    return { success: false, permanentFailure: true, raw: { reason: "invalid_email" } };
  }

  const mockId = `mock_mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.info("[S7_NOTIFICATION][email_provider_mock]", {
    providerMessageId: mockId,
    destination_domain: dest.split("@")[1] ?? "unknown",
  });

  return {
    success: true,
    providerMessageId: mockId,
    raw: { mock: true },
  };
}
