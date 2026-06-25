// =============================================================================

// E-mail manual Relatório de Vendas — padrão S7 Mail v1.

// Estruturalmente idêntico ao Relatório de Concorrência (referência oficial).

// =============================================================================



const EMAIL_TITLE = "Relatório de Vendas";



/** Nomes dos anexos no canal E-mail (entrega; artefatos inalterados). */

export const SALES_REPORT_EMAIL_IMAGE_FILENAME = "Resumo Executivo.png";

export const SALES_REPORT_EMAIL_DOCUMENT_FILENAME = "Relatório de Vendas.xlsx";



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

 * @param {{

 *   recipientName?: string | null;
 *   title?: string | null;
 *   introLine?: string | null;
 *   attachmentLabelImage?: string | null;
 *   attachmentLabelDocument?: string | null;

 * }} input

 */

export function renderSalesReportManualEmailBody(input) {

  const recipientName =

    input.recipientName != null && String(input.recipientName).trim() !== ""

      ? String(input.recipientName).trim()

      : null;

  const greeting = recipientName ? `Olá, ${recipientName}.` : "Olá.";

  const title =
    input.title != null && String(input.title).trim() !== ""
      ? String(input.title).trim()
      : EMAIL_TITLE;
  const introLine =
    input.introLine != null && String(input.introLine).trim() !== ""
      ? String(input.introLine).trim()
      : "Seu relatório foi gerado com sucesso e está disponível nos anexos deste e-mail.";
  const attachmentLabelImage =
    input.attachmentLabelImage != null && String(input.attachmentLabelImage).trim() !== ""
      ? String(input.attachmentLabelImage).trim()
      : "Resumo executivo";
  const attachmentLabelDocument =
    input.attachmentLabelDocument != null && String(input.attachmentLabelDocument).trim() !== ""
      ? String(input.attachmentLabelDocument).trim()
      : "Planilha Excel detalhada";

  const logoSrc = "cid:s7_mail_logo";



  const text = [

    greeting,

    "",

    introLine,

    "",

    "O material inclui um resumo executivo para análise rápida e uma planilha detalhada para acompanhamento completo das informações.",

    "",

    "Em anexo:",

    "",

    `• ${attachmentLabelImage}`,

    "",

    `• ${attachmentLabelDocument}`,

    "",

    "Gerado por Suse7 Precifica.",

    "Inteligência em Vendas.",

    "",

    title,

    "",

    "Um forte abraço,",

    "Equipe Suse7",

    "",

    "E-mail operacional automático.",

    "Não responda esta mensagem.",

  ].join("\n");



  const html = `<!DOCTYPE html>

<html lang="pt-BR">

<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>

<body style="margin:0;padding:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">

    <tr><td align="center">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.08);">

        <tr><td style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:22px 24px;">

          <table role="presentation" cellpadding="0" cellspacing="0">

            <tr>

              <td style="vertical-align:middle;">

                <img src="${escapeHtml(logoSrc)}" alt="Suse7" width="34" height="34" style="display:block;width:34px;height:34px;border-radius:999px;object-fit:cover;background:rgba(255,255,255,0.16);" />

              </td>

              <td style="padding-left:10px;vertical-align:middle;">

                <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;line-height:1.35;">${escapeHtml(title)}</h1>

              </td>

            </tr>

          </table>

        </td></tr>

        <tr><td style="padding:28px 24px 20px;background:#ffffff;">

          <p style="margin:0 0 12px;font-size:15px;color:#334155;">${escapeHtml(greeting)}</p>

          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">${escapeHtml(
            introLine
          )}</p>

          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">O material inclui um resumo executivo para análise rápida e uma planilha detalhada para acompanhamento completo das informações.</p>

          <p style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#475569;">Em anexo:</p>

          <p style="margin:0 0 2px;font-size:15px;line-height:1.55;color:#334155;">• ${escapeHtml(
            attachmentLabelImage
          )}</p>

          <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#334155;">• ${escapeHtml(
            attachmentLabelDocument
          )}</p>

          <p style="margin:20px 0 0;font-size:14px;line-height:1.55;color:#334155;white-space:pre-wrap;">Gerado por Suse7 Precifica.<br/>Inteligência em Vendas.<br/><br/>${escapeHtml(title)}<br/><br/>Um forte abraço,<br/>Equipe Suse7</p>

        </td></tr>

        <tr><td style="background:linear-gradient(135deg,#2563eb,#1d4ed8);padding:14px 24px 18px;">

          <p style="margin:0;font-size:12px;line-height:1.45;color:rgba(255,255,255,0.92);">E-mail operacional automático.<br/>Não responda esta mensagem.</p>

        </td></tr>

      </table>

    </td></tr>

  </table>

</body>

</html>`;



  return {

    subject: title,

    html,

    text,

  };

}

