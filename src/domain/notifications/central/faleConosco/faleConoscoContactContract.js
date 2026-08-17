// =============================================================================
// S7 — Fale Conosco — contrato HTTP público (formulário ↔ backend)
// Compatível com Edge legada: name, email, subject, message
// =============================================================================

export const S7_FALE_CONOSCO_CONTACT_FIELDS = Object.freeze([
  "name",
  "email",
  "subject",
  "message",
]);

/**
 * Normaliza corpo da requisição (JSON do ContactModal / FormData serializado).
 * Não valida — apenas alinha nomes e tipos.
 * @param {Record<string, unknown> | null | undefined} body
 */
export function normalizeFaleConoscoContactBody(body) {
  const raw = body && typeof body === "object" ? body : {};

  const name = String(raw.name ?? raw.full_name ?? raw.nome ?? "").trim();
  const email = String(raw.email ?? raw.sender_email ?? raw.e_mail ?? "")
    .trim()
    .toLowerCase();
  const subject = String(raw.subject ?? raw.assunto ?? raw.subject_key ?? "").trim();
  const message = String(
    raw.message ?? raw.body ?? raw.mensagem ?? raw.text ?? ""
  ).trim();

  return { name, email, subject, message };
}
