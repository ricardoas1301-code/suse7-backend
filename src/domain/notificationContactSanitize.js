// ============================================================
// Sanitização / validação — contatos de notificação (Fase 1)
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/** Mantém apenas dígitos (E.164 parcial sem '+'); null se vazio */
export function sanitizeWhatsApp(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/** E-mail normalizado (trim + lowercase) ou null */
export function sanitizeEmail(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

export function validateContactChannels({ whatsapp, email }) {
  if (!whatsapp && !email) {
    return { ok: false, message: "Informe pelo menos WhatsApp ou e-mail." };
  }
  return { ok: true };
}
