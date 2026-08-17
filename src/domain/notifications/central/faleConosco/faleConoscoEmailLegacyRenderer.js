// =============================================================================
// S7 — Fale Conosco — apresentação de e-mail homologada (contrato legado)
// Central de Templates S5.4 fornece subject/body; este módulo aplica o shell visual.
// =============================================================================

import { renderNotificationEmailTemplate } from "../email/renderNotificationEmailTemplate.js";

/**
 * @param {{
 *   contact_name: string;
 *   contact_email: string;
 *   contact_subject: string;
 *   contact_message: string;
 * }} vars
 */
export function renderFaleConoscoTeamEmail(vars) {
  const messageBlock = [
    "Nova mensagem pelo formulário Fale Conosco:",
    "",
    `Nome: ${vars.contact_name}`,
    `E-mail: ${vars.contact_email}`,
    `Assunto: ${vars.contact_subject}`,
    "",
    "Mensagem:",
    vars.contact_message,
  ].join("\n");

  return renderNotificationEmailTemplate({
    subject: `[Fale Conosco] ${vars.contact_subject}`,
    title: `[Fale Conosco] ${vars.contact_subject}`,
    message: messageBlock,
    category: "SYSTEM",
    type: "FALE_CONOSCO_TEAM",
    recipientLabel: "Equipe Suse7",
    presentation: "contact_form",
  });
}

/**
 * @param {{
 *   contact_name: string;
 *   contact_subject: string;
 * }} vars
 */
export function renderFaleConoscoConfirmationEmail(vars) {
  const messageBlock = [
    `Olá ${vars.contact_name},`,
    "",
    `Recebemos sua mensagem com o assunto "${vars.contact_subject}".`,
    "",
    "Nossa equipe retornará o contato em breve pelo e-mail informado.",
    "",
    "— Equipe Suse7",
  ].join("\n");

  return renderNotificationEmailTemplate({
    subject: "Recebemos sua mensagem — Suse7",
    title: "Recebemos sua mensagem",
    message: messageBlock,
    category: "SYSTEM",
    type: "FALE_CONOSCO_CONFIRMATION",
    recipientLabel: vars.contact_name,
    presentation: "contact_form",
  });
}
