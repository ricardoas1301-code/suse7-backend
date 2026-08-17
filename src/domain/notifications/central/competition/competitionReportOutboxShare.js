// =============================================================================
// Patch outbox — Relatório de Concorrência (WhatsApp imagem + Excel, E-mail imagem + Excel).
// =============================================================================

import { S7_MAIL_LOGO_DATA_URI } from "../email/s7MailLogoDataUri.js";

/**
 * WhatsApp: legenda textual + anexo Excel (sem imagem PNG).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {{
 *   caption?: string | null;
 *   documentBase64?: string | null;
 *   documentFilename?: string | null;
 *   documentMimeType?: string | null;
 * }} share
 */
export async function patchCompetitionReportWhatsAppOutboxShare(supabase, dispatchId, share) {
  const id = String(dispatchId ?? "").trim();
  if (!id) return { ok: false, error: "MISSING_DISPATCH_ID" };

  const caption = String(share.caption ?? "").trim();
  const documentBase64 = String(share.documentBase64 ?? "").trim();
  const documentFilename = String(share.documentFilename ?? "").trim() || "relatorio-concorrencia.xlsx";
  const documentMimeType =
    share.documentMimeType != null
      ? String(share.documentMimeType)
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const documentDataUri = documentBase64
    ? documentBase64.startsWith("data:")
      ? documentBase64
      : `data:${documentMimeType};base64,${documentBase64}`
    : "";

  const { data: row, error } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .select("id, metadata")
    .eq("dispatch_id", id)
    .maybeSingle();

  if (error) throw error;
  if (!row?.id) return { ok: false, error: "OUTBOX_NOT_FOUND" };

  const prev =
    row.metadata && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : {};

  const { error: updErr } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .update({
      message_text: caption,
      metadata: {
        ...prev,
        delivery_format: "text",
        share_caption: caption || null,
        ...(documentDataUri
          ? {
              share_document_data_uri: documentDataUri,
              share_document_filename: documentFilename,
              share_document_mime: documentMimeType,
            }
          : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updErr) throw updErr;
  return { ok: true, outbox_id: String(row.id) };
}

/**
 * E-mail: corpo padronizado + anexos PNG (resumo executivo) e Excel.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {{
 *   subject: string;
 *   html: string;
 *   text: string;
 *   imageDataUri?: string | null;
 *   imageFilename?: string | null;
 *   documentBase64?: string | null;
 *   documentFilename?: string | null;
 *   documentMimeType?: string | null;
 * }} share
 */
export async function patchCompetitionReportEmailOutboxShare(supabase, dispatchId, share) {
  const id = String(dispatchId ?? "").trim();
  if (!id) return { ok: false, error: "MISSING_DISPATCH_ID" };

  const documentBase64 = String(share.documentBase64 ?? "").trim();
  const documentFilename =
    String(share.documentFilename ?? "").trim() || "relatorio-concorrencia.xlsx";
  const documentMimeType =
    share.documentMimeType != null
      ? String(share.documentMimeType)
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const documentDataUri = documentBase64
    ? documentBase64.startsWith("data:")
      ? documentBase64
      : `data:${documentMimeType};base64,${documentBase64}`
    : "";

  const imageDataUri = String(share.imageDataUri ?? "").trim();
  const imageFilename = String(share.imageFilename ?? "").trim() || "relatorio-concorrencia.png";

  const { data: row, error } = await supabase
    .from("s7_notification_email_outbox")
    .select("id, metadata")
    .eq("dispatch_id", id)
    .maybeSingle();

  if (error) throw error;
  if (!row?.id) return { ok: false, error: "OUTBOX_NOT_FOUND" };

  const prev =
    row.metadata && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : {};

  const { error: updErr } = await supabase
    .from("s7_notification_email_outbox")
    .update({
      subject: String(share.subject ?? "").trim(),
      body_html: String(share.html ?? ""),
      body_text: String(share.text ?? ""),
      metadata: {
        ...prev,
        competition_report_manual_email: true,
        delivery_format: "image",
        share_email_file_attachments: true,
        s7_mail_logo_data_uri: S7_MAIL_LOGO_DATA_URI,
        s7_mail_logo_filename: "suse7-logo-abreviada.png",
        share_image_data_uri: imageDataUri || null,
        share_image_filename: imageFilename,
        ...(documentDataUri
          ? {
              share_document_data_uri: documentDataUri,
              share_document_filename: documentFilename,
              share_document_mime: documentMimeType,
            }
          : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updErr) throw updErr;
  return { ok: true, outbox_id: String(row.id) };
}
