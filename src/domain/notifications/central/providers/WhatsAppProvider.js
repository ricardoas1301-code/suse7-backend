import { NotificationDeliveryProvider } from "./NotificationDeliveryProvider.js";
import { createWhatsAppOutboxEntry } from "../whatsapp/createWhatsAppOutboxEntry.js";
import { logWhatsAppNotification } from "../whatsapp/whatsappLog.js";
import { renderNotificationWhatsAppTemplate } from "../whatsapp/renderNotificationWhatsAppTemplate.js";
import { renderNotificationWhatsAppSandboxTemplate } from "../whatsapp/renderNotificationWhatsAppSandboxTemplate.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";
import { isDevSandboxWhatsAppMode } from "../whatsapp/whatsappSandboxPolicy.js";
import { isWhatsAppLiveDeliveryActive } from "../whatsapp/S7WhatsAppProvider.js";

export class WhatsAppNotificationProvider extends NotificationDeliveryProvider {
  constructor() {
    super(isWhatsAppLiveDeliveryActive() ? "s7_whatsapp_live" : "s7_whatsapp_mock");
  }

  /** @param {import("./NotificationDeliveryProvider.js").NotificationDeliveryContext} ctx */
  async deliver(ctx) {
    const destination =
      ctx.destination != null ? String(ctx.destination).replace(/\D/g, "") : "";
    if (!destination || destination.length < 10) {
      logWhatsAppNotification("SKIPPED", { dispatch_id: ctx.dispatchId, reason: "NO_DESTINATION" });
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

    const renderInput = {
      subject: ctx.renderedSubject,
      title: ctx.renderedSubject,
      message: ctx.renderedBody,
      category,
      type,
      deepLink,
      payload: variables,
      entityType: ctx.metadata?.entity_type ?? null,
      entityId: ctx.metadata?.entity_id ?? null,
    };

    const rendered = isDevSandboxWhatsAppMode()
      ? renderNotificationWhatsAppSandboxTemplate(renderInput)
      : renderNotificationWhatsAppTemplate(renderInput);

    const outbox = await createWhatsAppOutboxEntry(ctx.supabase, {
      sellerId: ctx.sellerId,
      dispatchId: ctx.dispatchId,
      recipientId: ctx.metadata?.recipient_id ?? null,
      recipientPhone: destination,
      messageText: rendered.message_text,
      metadata: {
        category_code: category,
        type_key: type,
        deep_link: rendered.deep_link,
        cta_href: rendered.cta_href,
        event_id: ctx.metadata?.event_id ?? null,
        template_variant: isDevSandboxWhatsAppMode() ? "sandbox_35b" : "default",
        char_count: rendered.char_count ?? null,
        logical_subject: rendered.logical_subject ?? null,
        over_ideal_length: rendered.over_ideal_length ?? false,
      },
    });

    if (!outbox.ok) {
      return { ok: false, error: outbox.error ?? "OUTBOX_FAILED" };
    }

    return {
      ok: true,
      queued: true,
      providerResponse: {
        channel: "whatsapp",
        outbox_id: outbox.outboxId ?? null,
        idempotent: Boolean(outbox.idempotent),
        queued: true,
        simulated_until_process: !isWhatsAppLiveDeliveryActive(),
      },
    };
  }
}
