// =============================================================================
// Template HTML/text premium S7 — e-mails do motor central
// =============================================================================

import { config } from "../../../../infra/config.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";

/**
 * @param {{
 *   subject?: string;
 *   title?: string;
 *   message?: string;
 *   category?: string;
 *   type?: string;
 *   deepLink?: string | null;
 *   recipientLabel?: string | null;
 * }} input
 */
export function renderNotificationEmailTemplate(input) {
  const title = String(input.title ?? input.subject ?? "Notificação Suse7").trim();
  const message = String(input.message ?? "").trim();
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();

  const deepLink =
    input.deepLink != null && String(input.deepLink).trim() !== ""
      ? String(input.deepLink).trim()
      : resolveInAppDeepLink({
          category,
          type,
          payload: {},
        });

  const baseUrl = (config.frontendUrl || "https://suse7.com.br").replace(/\/+$/, "");
  const ctaHref = deepLink.startsWith("http") ? deepLink : `${baseUrl}${deepLink.startsWith("/") ? deepLink : `/${deepLink}`}`;
  const subject = String(input.subject ?? "").trim() || `[Suse7] ${title}`;

  const greeting = input.recipientLabel
    ? `Olá, ${String(input.recipientLabel).trim()},`
    : "Olá,";

  const text = [
    greeting,
    "",
    title,
    message,
    "",
    "Ver detalhes no Suse7:",
    ctaHref,
    "",
    "— Equipe Suse7",
    "Este é um e-mail operacional automático. Não responda a esta mensagem.",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
        <tr><td style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:24px 28px;">
          <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.85);">Suse7</p>
          <h1 style="margin:8px 0 0;font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;">${escapeHtml(title)}</h1>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px;font-size:15px;color:#334155;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;">${escapeHtml(message)}</p>
          <a href="${escapeAttr(ctaHref)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;">Ver detalhes no Suse7</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;line-height:1.45;color:#94a3b8;">E-mail operacional automático. Não responda a esta mensagem.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text, deep_link: deepLink, cta_href: ctaHref };
}

/**
 * @param {string} value
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {string} value
 */
function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
