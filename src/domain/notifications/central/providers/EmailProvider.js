import { NotificationDeliveryProvider } from "./NotificationDeliveryProvider.js";
import { createEmailOutboxEntry } from "../email/createEmailOutboxEntry.js";
import { logEmailNotification } from "../email/emailLog.js";
import { renderNotificationEmailTemplate } from "../email/renderNotificationEmailTemplate.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";
import { isRealEmailProviderConfigured } from "../email/S7EmailProvider.js";

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
    const deepLink = resolveInAppDeepLink({
      category,
      type,
      entityType: ctx.metadata?.entity_type ?? null,
      entityId: ctx.metadata?.entity_id ?? null,
      payload:
        ctx.metadata?.variables && typeof ctx.metadata.variables === "object"
          ? ctx.metadata.variables
          : {},
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
