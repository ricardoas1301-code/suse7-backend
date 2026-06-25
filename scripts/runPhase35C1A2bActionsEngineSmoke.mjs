#!/usr/bin/env node
/**
 * S7 Mission Control — Fase 3.5C.1.A2b — Actions Engine Smoke (sem live)
 *
 * publishNotificationEvent → dispatch → actions engine → outbox pending
 * Não chama processWhatsAppOutbox (sem envio real/mock send).
 *
 * node scripts/runPhase35C1A2bActionsEngineSmoke.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import {
  SUITE_35_WHATSAPP_EVENT,
  purgeEventDeliveryRulesForEvent,
  purgeRecipientsByDestinationHints,
  resolveSellerIdByEmail,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const SMOKE_PHONE = String(process.env.S7_ACTIONS_SMOKE_PHONE ?? "5511999999999").replace(/\D/g, "");
const actionsDir = resolve(root, "src/domain/notifications/central/actions");

/** @type {Record<string, string | undefined>} */
const envSnapshot = {
  S7_WHATSAPP_MODE: process.env.S7_WHATSAPP_MODE,
  S7_ALLOW_LIVE_DELIVERY: process.env.S7_ALLOW_LIVE_DELIVERY,
  S7_PROVIDER_SMOKE_ENABLED: process.env.S7_PROVIDER_SMOKE_ENABLED,
  S7_ZAPI_SMOKE_RUN: process.env.S7_ZAPI_SMOKE_RUN,
};

function applySafeEnv() {
  process.env.S7_WHATSAPP_MODE = "mock";
  process.env.S7_ALLOW_LIVE_DELIVERY = "false";
  process.env.S7_PROVIDER_SMOKE_ENABLED = "false";
  process.env.S7_ZAPI_SMOKE_RUN = "false";
}

function restoreEnv() {
  for (const [key, val] of Object.entries(envSnapshot)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function walkJs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJs(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function assertNoZapiInActionsEngine() {
  const leaks = walkJs(actionsDir).filter((p) => readFileSync(p, "utf8").includes("zapiHttpClient"));
  if (leaks.length > 0) {
    throw new Error(`Z-API leak in actions engine: ${leaks.join(", ")}`);
  }
}

async function ensureSingleWhatsAppRecipient(sb, sellerId, runToken) {
  await purgeRecipientsByDestinationHints(sb, sellerId, [SMOKE_PHONE, `p35c1a2b.${runToken}`]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );

  const groupId = randomUUID();
  const { data: existing } = await sb
    .from("s7_notification_recipients")
    .select("id, destination, recipient_group_id")
    .eq("seller_id", sellerId)
    .eq("channel", "whatsapp");

  const match = (existing ?? []).find(
    (r) => String(r.destination ?? "").replace(/\D/g, "") === SMOKE_PHONE
  );

  if (match?.id) {
    await sb
      .from("s7_notification_recipients")
      .update({
        is_active: true,
        recipient_group_id: groupId,
        label: `p35c1a2b ${runToken}`,
      })
      .eq("id", match.id);
  } else {
    const { error } = await sb.from("s7_notification_recipients").insert({
      seller_id: sellerId,
      channel: "whatsapp",
      destination: SMOKE_PHONE,
      label: `p35c1a2b ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    });
    if (error) throw new Error(`recipient: ${error.message}`);
  }

  const { error: ruleErr } = await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: sellerId,
    category_code: SUITE_35_WHATSAPP_EVENT.category,
    type_key: SUITE_35_WHATSAPP_EVENT.type_key,
    channel: "whatsapp",
    recipient_group_id: groupId,
    enabled: true,
  });
  if (ruleErr) throw new Error(`rule: ${ruleErr.message}`);

  return groupId;
}

async function main() {
  console.log("=== S7 Fase 3.5C.1.A2b — Actions Engine Smoke (mock) ===\n");

  applySafeEnv();
  assertNoZapiInActionsEngine();

  const { isWhatsAppLiveDeliveryActive, isRealWhatsAppProviderConfigured } = await import(
    "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js"
  );
  if (isWhatsAppLiveDeliveryActive() || isRealWhatsAppProviderConfigured()) {
    console.error("ABORT: live delivery ativo — smoke exige modo mock seguro");
    restoreEnv();
    process.exit(2);
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("ABORT: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    restoreEnv();
    process.exit(2);
  }

  const testEmail =
    process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const sellerId =
    process.env.S7_PROVIDER_SMOKE_SELLER?.trim() ||
    (await resolveSellerIdByEmail(sb, testEmail));

  if (!sellerId) {
    console.error("ABORT: seller não encontrado");
    restoreEnv();
    process.exit(2);
  }

  const runToken = String(Date.now());
  const correlationId = `p35c1a2b.${runToken}`;
  const idempotencyKey = `p35c1a2b.${runToken}.actions`;

  await ensureSingleWhatsAppRecipient(sb, sellerId, runToken);

  const { resolveNotificationChannels } = await import(
    "../src/domain/notifications/central/actions/notificationChannelResolver.js"
  );
  const { resolveNotificationActionRecipients } = await import(
    "../src/domain/notifications/central/actions/notificationRecipientResolver.js"
  );
  const { planNotificationActions } = await import(
    "../src/domain/notifications/central/actions/notificationActionsEngine.js"
  );
  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { NOTIFICATION_ACTION_STATUS } = await import(
    "../src/domain/notifications/central/actions/notificationActionTypes.js"
  );
  const { S7_WHATSAPP_OUTBOX_STATUS } = await import(
    "../src/domain/notifications/central/whatsapp/whatsappOutboxStatus.js"
  );

  const channelsResolved = await resolveNotificationChannels(sb, {
    sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
  });

  const waRecipients = await resolveNotificationActionRecipients(sb, {
    sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    channel: "whatsapp",
  });
  const waForSmoke = waRecipients.filter(
    (r) => String(r.destination ?? "").replace(/\D/g, "") === SMOKE_PHONE
  );

  const planOnly = await planNotificationActions(
    sb,
    {
      seller_id: sellerId,
      category_key: SUITE_35_WHATSAPP_EVENT.category,
      event_type: SUITE_35_WHATSAPP_EVENT.type_key,
      payload: { plan_name: "Actions Engine Smoke 3.5C.1.A2b" },
      correlation_id: correlationId,
    },
    { locale: "pt-BR" }
  );

  const plannedWa = (planOnly.actions ?? []).filter(
    (a) =>
      a.channel === "whatsapp" &&
      a.status === NOTIFICATION_ACTION_STATUS.PLANNED &&
      String(a.recipient_contact ?? "").replace(/\D/g, "") === SMOKE_PHONE
  );

  const pub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    payload: { plan_name: "Actions Engine Smoke 3.5C.1.A2b", smoke_run: runToken },
    force_redispatch: true,
  });

  if (!pub.ok || !pub.event?.id) {
    console.error("ABORT: publish falhou", pub);
    restoreEnv();
    process.exit(4);
  }

  const eventId = String(pub.event.id);
  const waDispatch = (pub.dispatches?.dispatches ?? []).find((d) => d.channel === "whatsapp");

  const { data: ob } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("id, status, metadata, provider_message_id, dispatch_id")
    .eq("dispatch_id", waDispatch?.dispatchId ?? "__none__")
    .maybeSingle();

  const { data: disp } = await sb
    .from("s7_notification_dispatches")
    .select("id, status, channel, correlation_id, metadata")
    .eq("id", waDispatch?.dispatchId ?? "__none__")
    .maybeSingle();

  const replay = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    payload: { plan_name: "Actions Engine Smoke 3.5C.1.A2b replay" },
    force_redispatch: false,
  });

  const { count: outboxCount } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("id", { count: "exact", head: true })
    .eq("dispatch_id", waDispatch?.dispatchId ?? "__none__");

  await purgeRecipientsByDestinationHints(sb, sellerId, [SMOKE_PHONE, `p35c1a2b.${runToken}`]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );

  restoreEnv();

  const checks = {
    channels_include_whatsapp: channelsResolved.channels.includes("whatsapp"),
    smoke_recipient_resolved: waForSmoke.length >= 1,
    planned_whatsapp_action: plannedWa.length >= 1,
    planned_has_slot_key: plannedWa.every((a) => Boolean(a.slot_key)),
    planned_has_correlation: plannedWa.every(
      (a) => a.metadata?.correlation_id === correlationId
    ),
    publish_ok: pub.ok === true,
    dispatch_created: Boolean(waDispatch?.dispatchId),
    dispatch_queued: waDispatch?.status === "QUEUED",
    outbox_exists: Boolean(ob?.id),
    outbox_pending: ob?.status === S7_WHATSAPP_OUTBOX_STATUS.PENDING,
    outbox_no_provider_message_id: !ob?.provider_message_id,
    dispatch_actions_engine_flag:
      disp?.metadata &&
      typeof disp.metadata === "object" &&
      /** @type {{ actions_engine?: boolean }} */ (disp.metadata).actions_engine === true,
    idempotent_replay: replay.idempotent === true && (replay.dispatches?.skipped_engine === true ||
      replay.dispatches?.inserted === 0),
    no_duplicate_outbox: (outboxCount ?? 0) <= 1,
    no_live_delivery: !isWhatsAppLiveDeliveryActive(),
  };

  const report = {
    run_token: runToken,
    event_id: eventId,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    seller_id: sellerId,
    channels_resolved: channelsResolved.channels,
    whatsapp_recipients_for_smoke: waForSmoke.length,
    planned_actions_total: planOnly.actions?.length ?? 0,
    planned_whatsapp_actions: plannedWa.map((a) => ({
      channel: a.channel,
      status: a.status,
      slot_key: a.slot_key,
      template_key: a.template_key,
      recipient_contact_masked: "*********" + SMOKE_PHONE.slice(-4),
      correlation_id: a.metadata?.correlation_id,
    })),
    dispatch_id: waDispatch?.dispatchId ?? null,
    dispatch_status: waDispatch?.status ?? null,
    outbox_id: ob?.id ?? null,
    outbox_status: ob?.status ?? null,
    outbox_rows_for_dispatch: outboxCount ?? 0,
    idempotent_replay: {
      idempotent: replay.idempotent,
      skipped_engine: replay.dispatches?.skipped_engine,
      reason: replay.dispatches?.reason,
      inserted: replay.dispatches?.inserted,
    },
    real_send_executed: false,
    process_whatsapp_outbox_called: false,
    checks,
    success: Object.values(checks).every(Boolean),
  };

  console.log("\n--- Relatório 3.5C.1.A2b ---");
  console.log(JSON.stringify(report, null, 2));

  process.exit(report.success ? 0 : 5);
}

main().catch((e) => {
  restoreEnv();
  console.error("FATAL", e);
  process.exit(1);
});
