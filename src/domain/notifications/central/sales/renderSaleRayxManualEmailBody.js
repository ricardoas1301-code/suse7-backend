// =============================================================================
// E-mail manual Raio-X — saudação personalizada + resumo textual padronizado.
// =============================================================================

import { config } from "../../../../infra/config.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";

const EMAIL_TITLE = "Raio-X da Venda";
const INTRO_LINE = "Segue o resumo do Raio-X da venda:";

const TECHNICAL_LABEL_PATTERN =
  /^(manual[_\s-]?sale[_\s-]?rayx|manual_sale_rayx|MANUAL_SALE_RAYX)$/i;

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

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function sanitizeRecipientName(raw) {
  const value = String(raw ?? "").trim();
  if (!value || TECHNICAL_LABEL_PATTERN.test(value)) return null;
  return value;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeSummaryText(raw) {
  const lines = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }

  const first = lines[0]?.trim() ?? "";
  if (/^Raio-X da Venda/i.test(first)) {
    lines.shift();
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
  }

  return lines.join("\n").trim();
}

/**
 * @param {{
 *   recipientName?: string | null;
 *   saleId?: string | null;
 *   summaryText?: string | null;
 *   plainTextFallback?: string | null;
 *   imageDataUri?: string | null;
 *   caption?: string | null;
 * }} input
 */
export function renderSaleRayxManualEmailBody(input) {
  const recipientName = sanitizeRecipientName(input.recipientName);
  const greeting = recipientName ? `Olá, ${recipientName}.` : "Olá.";
  const summaryBody = normalizeSummaryText(input.summaryText ?? input.plainTextFallback ?? input.caption);
  const title = EMAIL_TITLE;
  const subject = `[Suse7] ${title}`;

  const saleId = input.saleId != null ? String(input.saleId).trim() : "";
  const deepLink = resolveInAppDeepLink({
    category: "SALES",
    type: "MANUAL_SALE_RAYX",
    entityId: saleId || null,
    payload: {},
  });
  const baseUrl = (config.frontendUrl || "https://suse7.com.br").replace(/\/+$/, "");
  const ctaHref =
    deepLink != null
      ? deepLink.startsWith("http")
        ? deepLink
        : `${baseUrl}${deepLink.startsWith("/") ? deepLink : `/${deepLink}`}`
      : `${baseUrl}/vendas`;

  const text = [
    greeting,
    "",
    INTRO_LINE,
    "",
    summaryBody,
    "",
    ...(ctaHref ? ["Ver detalhes no Suse7:", ctaHref] : []),
    "",
    "Abraço,",
    "Equipe Suse7",
  ].join("\n");

  const imageDataUri = String(input.imageDataUri ?? "").trim();
  const safeImageSrc =
    imageDataUri.startsWith("data:image/") && !imageDataUri.includes('"') ? imageDataUri : "";

  const summaryHtml = summaryBody
    ? `<p style="margin:0;font-size:14px;line-height:1.55;color:#475569;white-space:pre-wrap;">${escapeHtml(summaryBody)}</p>`
    : "";

  const imageHtml = safeImageSrc
    ? `<div style="margin-top:20px;"><img src="${safeImageSrc}" alt="${escapeAttr(title)}" width="608" style="display:block;width:100%;max-width:608px;height:auto;border:0;border-radius:12px;" /></div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
        <tr><td style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:22px 24px;">
          <p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.85);">Suse7 Precifica</p>
          <h1 style="margin:8px 0 0;font-size:20px;font-weight:700;color:#ffffff;line-height:1.35;">${escapeHtml(title)}</h1>
        </td></tr>
        <tr><td style="padding:28px 24px 20px;background:#ffffff;">
          <p style="margin:0 0 12px;font-size:15px;color:#334155;">${escapeHtml(greeting)}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">${escapeHtml(INTRO_LINE)}</p>
          ${summaryHtml}
          ${imageHtml}
          ${
            ctaHref
              ? `<p style="margin:24px 0 0;"><a href="${escapeAttr(ctaHref)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;">Ver detalhes no Suse7</a></p>`
              : ""
          }
          <p style="margin:24px 0 0;font-size:14px;line-height:1.55;color:#334155;white-space:pre-wrap;">Abraço,<br/>Equipe Suse7</p>
        </td></tr>
        <tr><td style="padding:14px 24px 20px;border-top:1px solid #e2e8f0;background:#ffffff;">
          <p style="margin:0;font-size:12px;line-height:1.45;color:#94a3b8;">E-mail operacional automático. Não responda a esta mensagem.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text, title, cta_href: ctaHref };
}
