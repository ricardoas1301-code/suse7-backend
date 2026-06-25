import { NotificationDeliveryProvider } from "./NotificationDeliveryProvider.js";
import { createEmailOutboxEntry } from "../email/createEmailOutboxEntry.js";
import { logEmailNotification } from "../email/emailLog.js";
import { renderNotificationEmailTemplate } from "../email/renderNotificationEmailTemplate.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";
import { isRealEmailProviderConfigured } from "../email/S7EmailProvider.js";
import { processEmailOutbox } from "../email/processEmailOutbox.js";
import {
  buildDailySalesSummaryOutboxShare,
  isDailySalesSummaryMetadata,
} from "../sales/dailySalesSummaryOutboxShareAdapter.js";
import { patchSalesReportEmailOutboxShare } from "../sales/salesReportOutboxShare.js";

export class EmailNotificationProvider extends NotificationDeliveryProvider {
  constructor() {
    super(isRealEmailProviderConfigured() ? "s7_email_live" : "s7_email_mock");
  }

  /** @param {import("./NotificationDeliveryProvider.js").NotificationDeliveryContext} ctx */
  async deliver(ctx) {
    const destination = ctx.destination != null ? String(ctx.destination).trim().toLowerCase() : "";
    if (!destination || !destination.includes("@")) {
      logEmailNotification("SKIPPED", { dispatch_id: ctx.dispatchId, reason: "NO_DESTINATION" });
      return { ok: false, skipped: true, error: "NO_DESTINATION" };
    }

    if (!ctx.supabase) {
      return { ok: false, error: "NO_SUPABASE_CLIENT" };
    }

    const category = String(ctx.metadata?.category_code ?? "");
    const type = String(ctx.metadata?.type_key ?? "");
    const variables =
      ctx.metadata?.variables && typeof ctx.metadata.variables === "object"
        ? /** @type {Record<string, unknown>} */ (ctx.metadata.variables)
        : {};
    const deepLink = resolveInAppDeepLink({
      category,
      type,
      entityType: ctx.metadata?.entity_type ?? null,
      entityId: ctx.metadata?.entity_id ?? null,
      payload: variables,
    });

    const rendered = renderNotificationEmailTemplate({
      subject: ctx.renderedSubject,
      title: ctx.renderedSubject,
      message: ctx.renderedBody,
      category,
      type,
      deepLink,
      recipientLabel: ctx.metadata?.recipient_label ?? null,
    });

    const outbox = await createEmailOutboxEntry(ctx.supabase, {
      sellerId: ctx.sellerId,
      dispatchId: ctx.dispatchId,
      recipientId: ctx.metadata?.recipient_id ?? null,
      recipientEmail: destination,
      subject: rendered.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      metadata: {
        category_code: category,
        type_key: type,
        deep_link: rendered.deep_link,
        cta_href: rendered.cta_href,
        event_id: ctx.metadata?.event_id ?? null,
      },
    });

    if (!outbox.ok) {
      return { ok: false, error: outbox.error ?? "OUTBOX_FAILED" };
    }

    const isDailySummary = isDailySalesSummaryMetadata(ctx.metadata);
    if (isDailySummary && outbox.outboxId) {
      const share = await buildDailySalesSummaryOutboxShare({
        eventId: String(ctx.metadata?.event_id ?? ""),
        renderedSubject: ctx.renderedSubject,
        renderedBody: ctx.renderedBody,
        variables,
        recipientName: null,
      });

      await patchSalesReportEmailOutboxShare(ctx.supabase, ctx.dispatchId, {
        subject: share.emailSubject,
        html: share.emailHtml,
        text: share.emailText,
        imageDataUri: `data:${share.imageMimeType};base64,${share.imageBase64}`,
        imageFilename: share.imageFilename,
        documentBase64: share.documentBase64,
        documentMimeType: share.documentMimeType,
        documentFilename: share.documentFilename,
        metadataTag: "daily_sales_summary_auto_email",
      });

      const processResult = await processEmailOutbox(ctx.supabase, {
        dispatchId: ctx.dispatchId,
      });
      const processedSent = (processResult?.sent ?? 0) >= 1;

      return {
        ok: true,
        queued: !processedSent,
        providerResponse: {
          channel: "email",
          outbox_id: outbox.outboxId ?? null,
          idempotent: Boolean(outbox.idempotent),
          queued: !processedSent,
          processed_immediately: true,
          sent: processedSent,
          process_result: processResult ?? null,
        },
      };
    }

    return {
      ok: true,
      queued: true,
      providerResponse: {
        channel: "email",
        outbox_id: outbox.outboxId ?? null,
        idempotent: Boolean(outbox.idempotent),
        queued: true,
        simulated_until_process: !isRealEmailProviderConfigured(),
      },
    };
  }
}
