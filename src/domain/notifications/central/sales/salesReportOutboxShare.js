// =============================================================================

// Patch outbox — Relatório de Vendas (E-mail: anexos PNG + Excel, padrão S7 Mail v1).

// Mesmo contrato do Relatório de Concorrência — sem imagem inline no corpo HTML.

// =============================================================================



import { S7_MAIL_LOGO_DATA_URI } from "../email/s7MailLogoDataUri.js";

import {

  SALES_REPORT_EMAIL_DOCUMENT_FILENAME,

  SALES_REPORT_EMAIL_IMAGE_FILENAME,

} from "./renderSalesReportManualEmailBody.js";



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} dispatchId

 * @param {{

 *   subject: string;

 *   html: string;

 *   text: string;

 *   imageDataUri?: string | null;

 *   documentBase64?: string | null;

 *   documentMimeType?: string | null;
 *   imageFilename?: string | null;
 *   documentFilename?: string | null;
 *   metadataTag?: string | null;

 * }} share

 */

export async function patchSalesReportEmailOutboxShare(supabase, dispatchId, share) {

  const id = String(dispatchId ?? "").trim();

  if (!id) return { ok: false, error: "MISSING_DISPATCH_ID" };



  const documentBase64 = String(share.documentBase64 ?? "").trim();

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
  const imageFilename = String(share.imageFilename ?? "").trim() || SALES_REPORT_EMAIL_IMAGE_FILENAME;
  const documentFilename =
    String(share.documentFilename ?? "").trim() || SALES_REPORT_EMAIL_DOCUMENT_FILENAME;
  const metadataTag = String(share.metadataTag ?? "").trim() || "sales_report_manual_email";



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

        [metadataTag]: true,

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

