// =============================================================================
// S7 — Fale Conosco — acionamento via Motor Central (S5.13)
// =============================================================================

import { config } from "../../../../infra/config.js";
import { S7_NOTIFICATION_CATEGORY } from "../constants/categories.js";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { publishNotificationEvent } from "../events/publishNotificationEvent.js";
import { processEmailOutbox } from "../email/processEmailOutbox.js";
import { logNotificationActions } from "../actions/notificationActionsLog.js";
import {
  renderFaleConoscoConfirmationEmail,
  renderFaleConoscoTeamEmail,
} from "./faleConoscoEmailLegacyRenderer.js";
import { recordFaleConoscoMotorObservability } from "./faleConoscoMotorObservability.js";
import { S7_FALE_CONOSCO_FLOW } from "./faleConoscoMotorContract.js";
import {
  evaluateFaleConoscoLegOutcome,
  getFaleConoscoEmailRuntimeSnapshot,
  isFaleConoscoDeliveryConfirmed,
} from "./faleConoscoEmailLiveDelivery.js";

const INCOMPLETE_ERROR = "Campos incompletos.";
const DELIVERY_ERROR = "Erro ao enviar sua mensagem.";

/**
 * @param {string} raw
 */
export function resolveFaleConoscoSystemSellerId(raw) {
  const fromEnv = String(config.s7FaleConoscoSystemSellerId ?? "").trim();
  const id = fromEnv || String(raw ?? "").trim();
  return id || "00000000-0000-0000-0000-000000000001";
}

/**
 * @param {string} raw
 */
export function resolveFaleConoscoInboxEmail(raw) {
  const fromEnv = String(config.s7FaleConoscoInboxEmail ?? "").trim();
  const email = (fromEnv || String(raw ?? "").trim()).toLowerCase();
  return email || "contato@suse7.com.br";
}

/**
 * @param {{ name?: string; email?: string; subject?: string; message?: string }} input
 */
export function validateFaleConoscoContactInput(input) {
  const name = String(input?.name ?? "").trim();
  const email = String(input?.email ?? "").trim().toLowerCase();
  const subject = String(input?.subject ?? "").trim();
  const message = String(input?.message ?? "").trim();

  if (!name || !email || !subject || !message) {
    return { ok: false, error: INCOMPLETE_ERROR };
  }
  if (!email.includes("@") || email.length < 5) {
    return { ok: false, error: INCOMPLETE_ERROR };
  }
  if (message.length > 8000) {
    return { ok: false, error: "Mensagem muito longa." };
  }

  return {
    ok: true,
    contact_name: name,
    contact_email: email,
    contact_subject: subject,
    contact_message: message,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {{ subject: string; html: string; text: string }} rendered
 */
async function patchFaleConoscoEmailOutbox(supabase, dispatchId, rendered) {
  if (!dispatchId) return;
  await supabase
    .from("s7_notification_email_outbox")
    .update({
      subject: rendered.subject,
      body_html: rendered.html,
      body_text: rendered.text,
      updated_at: new Date().toISOString(),
      metadata: {
        fale_conosco_motor: true,
        motor_phase: "S5.13",
        policy_context: "fale_conosco",
      },
    })
    .eq("dispatch_id", dispatchId);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   type: string;
 *   destination: string;
 *   variables: Record<string, string>;
 *   correlationId: string;
 *   idempotencyKey: string;
 *   leg: "team" | "confirmation";
 * }} input
 */
async function publishAndDeliverFaleConoscoEmail(supabase, input) {
  const pub = await publishNotificationEvent(supabase, {
    seller_id: input.sellerId,
    category: S7_NOTIFICATION_CATEGORY.SYSTEM,
    type: input.type,
    correlation_id: input.correlationId,
    idempotency_key: input.idempotencyKey,
    payload: input.variables,
    source_module: S7_FALE_CONOSCO_FLOW.SOURCE_MODULE,
    entity_type: "contact_form_submission",
    entity_id: input.correlationId,
    dispatch_options: {
      channels_filter: [S7_NOTIFICATION_CHANNEL.EMAIL],
      manual_recipients_by_channel: {
        [S7_NOTIFICATION_CHANNEL.EMAIL]: {
          destination: input.destination,
          recipient_id: null,
        },
      },
    },
  });

  if (!pub.ok) {
    return {
      ok: false,
      error: pub.error ?? "PUBLISH_FAILED",
      leg: input.leg,
    };
  }

  const channelDispatch = (pub.dispatches?.dispatches ?? []).find(
    (d) => d.channel === S7_NOTIFICATION_CHANNEL.EMAIL
  );
  const dispatchId = channelDispatch?.dispatchId ?? null;

  if (!dispatchId) {
    return {
      ok: false,
      error: "DISPATCH_NOT_CREATED",
      leg: input.leg,
      event_id: pub.event?.id ?? null,
      skipped_engine: pub.dispatches?.skipped_engine === true,
    };
  }

  const rendered =
    input.leg === "team"
      ? renderFaleConoscoTeamEmail(input.variables)
      : renderFaleConoscoConfirmationEmail(input.variables);

  await patchFaleConoscoEmailOutbox(supabase, dispatchId, rendered);
  const processResult = await processEmailOutbox(supabase, { dispatchId });

  const { data: outbox } = await supabase
    .from("s7_notification_email_outbox")
    .select("id, status, provider_message_id, metadata, last_error")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();

  const meta =
    outbox?.metadata && typeof outbox.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (outbox.metadata)
      : {};

  const delivery_mode =
    meta.provider != null ? String(meta.provider) : String(config.s7EmailProvider ?? "mock");

  const legRow = {
    ok: true,
    leg: input.leg,
    event_id: pub.event?.id ?? null,
    dispatch_id: dispatchId,
    outbox_id: outbox?.id ?? null,
    outbox_status: outbox?.status ?? null,
    provider_message_id: outbox?.provider_message_id ?? null,
    metadata: meta,
    last_error: outbox?.last_error ?? null,
    delivery_mode,
    process_sent: processResult?.sent ?? 0,
    process_failed: processResult?.failed ?? 0,
  };

  recordFaleConoscoMotorObservability({
    leg: input.leg,
    event_id: legRow.event_id,
    dispatch_id: dispatchId,
    outbox_id: legRow.outbox_id,
    status: legRow.outbox_status,
    provider_key: delivery_mode,
    real_send_executed: isFaleConoscoDeliveryConfirmed(legRow),
  });

  return legRow;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ name: string; email: string; subject: string; message: string }} input
 */
export async function triggerFaleConoscoContact(supabase, input) {
  const validated = validateFaleConoscoContactInput(input);
  if (!validated.ok) {
    return { success: false, error: validated.error };
  }

  const sellerId = resolveFaleConoscoSystemSellerId();
  const inboxEmail = resolveFaleConoscoInboxEmail();
  const bucket = Math.floor(Date.now() / 60_000);
  const correlationId = `fale-conosco.${validated.contact_email}.${bucket}`;
  const variables = {
    contact_name: validated.contact_name,
    contact_email: validated.contact_email,
    contact_subject: validated.contact_subject,
    contact_message: validated.contact_message,
  };

  const emailRuntime = getFaleConoscoEmailRuntimeSnapshot();

  logNotificationActions("FALE_CONOSCO_START", {
    correlation_id: correlationId,
    contact_email_masked: `${validated.contact_email.slice(0, 2)}***`,
    contact_subject: validated.contact_subject,
    inbox_email: inboxEmail,
    ...emailRuntime,
  });

  const [team, confirmation] = await Promise.all([
    publishAndDeliverFaleConoscoEmail(supabase, {
      sellerId,
      type: S7_FALE_CONOSCO_FLOW.TYPE_TEAM,
      destination: inboxEmail,
      variables,
      correlationId,
      idempotencyKey: `fale-conosco.team:${correlationId}`,
      leg: "team",
    }),
    publishAndDeliverFaleConoscoEmail(supabase, {
      sellerId,
      type: S7_FALE_CONOSCO_FLOW.TYPE_CONFIRMATION,
      destination: validated.contact_email,
      variables,
      correlationId,
      idempotencyKey: `fale-conosco.confirmation:${correlationId}`,
      leg: "confirmation",
    }),
  ]);

  const teamOutcome = evaluateFaleConoscoLegOutcome(team);
  const confirmationOutcome = evaluateFaleConoscoLegOutcome(confirmation);
  const delivered = teamOutcome.delivered === true && confirmationOutcome.delivered === true;

  logNotificationActions("FALE_CONOSCO_COMPLETE", {
    correlation_id: correlationId,
    delivered,
    team_reason: teamOutcome.reason,
    confirmation_reason: confirmationOutcome.reason,
    team_dispatch_id: team.dispatch_id ?? null,
    confirmation_dispatch_id: confirmation.dispatch_id ?? null,
    team_outbox_status: team.outbox_status ?? null,
    confirmation_outbox_status: confirmation.outbox_status ?? null,
    team_delivery_mode: team.delivery_mode ?? null,
    confirmation_delivery_mode: confirmation.delivery_mode ?? null,
    team_last_error: team.last_error ?? null,
    confirmation_last_error: confirmation.last_error ?? null,
    team_provider_message_id: team.provider_message_id ?? null,
    confirmation_provider_message_id: confirmation.provider_message_id ?? null,
    ...emailRuntime,
  });

  if (!delivered) {
    const failureCode =
      teamOutcome.reason === "EMAIL_PROVIDER_NOT_CONFIGURED" ||
      confirmationOutcome.reason === "EMAIL_PROVIDER_NOT_CONFIGURED"
        ? "EMAIL_PROVIDER_NOT_CONFIGURED"
        : team.error === "DISPATCH_NOT_CREATED" ||
            confirmation.error === "DISPATCH_NOT_CREATED"
          ? "DISPATCH_NOT_CREATED"
          : team.error ?? confirmation.error
            ? "PIPELINE_FAILED"
            : "DELIVERY_NOT_CONFIRMED";

    logNotificationActions("FALE_CONOSCO_DELIVERY_FAILED", {
      correlation_id: correlationId,
      failure_code: failureCode,
      payload_accepted: true,
      team: teamOutcome,
      confirmation: confirmationOutcome,
      team_leg: {
        ok: team.ok,
        dispatch_id: team.dispatch_id,
        outbox_status: team.outbox_status,
        last_error: team.last_error,
      },
      confirmation_leg: {
        ok: confirmation.ok,
        dispatch_id: confirmation.dispatch_id,
        outbox_status: confirmation.outbox_status,
        last_error: confirmation.last_error,
      },
      ...emailRuntime,
    });
    return { success: false, error: DELIVERY_ERROR, failure_code: failureCode };
  }

  return { success: true, failure_code: null };
}
