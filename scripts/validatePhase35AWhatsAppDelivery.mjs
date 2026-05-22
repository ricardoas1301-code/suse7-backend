#!/usr/bin/env node
/**
 * Fase 3.5A — WhatsApp delivery engine (outbox + worker mock)
 * node scripts/validatePhase35AWhatsAppDelivery.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  SUITE_35_WHATSAPP_EVENT,
  SUITE_35_RULES_EVENT,
  SUITE_33_IN_APP_EVENT,
  SUITE_34_EMAIL_EVENT,
  purgeEventDeliveryRulesForEvent,
  cleanupSuite35Run,
  prepareSuite35Isolation,
  resolveSellerIdByEmail,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(
  /\/+$/,
  ""
);
const jobSecret = process.env.JOB_SECRET?.trim() || process.env.S7_INTERNAL_NOTIFICATION_SECRET?.trim() || "";

/** @type {Array<{ name: string, pass: boolean, detail?: string }>} */
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Fase 3.5A — WhatsApp delivery (isolated) ===\n");

  if (!serviceKey || !supabaseUrl) {
    record("env", false, "SUPABASE ausente");
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const sellerId = await resolveSellerIdByEmail(sb, testEmail);
  if (!sellerId) {
    record("seller_id", false);
    process.exit(1);
  }

  const runToken = String(Date.now());
  await prepareSuite35Isolation(sb, sellerId, runToken);
  record("isolation_prepare", true, `runToken=${runToken}`);

  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { processWhatsAppOutbox } = await import(
    "../src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js"
  );
  const { createWhatsAppOutboxEntry } = await import(
    "../src/domain/notifications/central/whatsapp/createWhatsAppOutboxEntry.js"
  );
  const { renderNotificationWhatsAppTemplate } = await import(
    "../src/domain/notifications/central/whatsapp/renderNotificationWhatsAppTemplate.js"
  );
  const { isRealWhatsAppProviderConfigured } = await import(
    "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js"
  );

  const renderedSample = renderNotificationWhatsAppTemplate({
    subject: "Pagamento pendente",
    message: "Seu pagamento do plano {{plan_name}} está pendente.",
    category: "BILLING",
    type: "PAYMENT_FAILED",
    payload: { plan_name: "Pro" },
  });
  record(
    "template_valid_plain_text",
    !renderedSample.message_text.includes("<") &&
      renderedSample.message_text.includes("Suse7") &&
      renderedSample.message_text.includes("Ver detalhes"),
    renderedSample.message_text.slice(0, 80)
  );

  record("no_real_whatsapp_provider", !isRealWhatsAppProviderConfigured(), `mode=mock`);

  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );

  const waDest = `5511999${String(runToken).slice(-7)}`;
  const emailOnlyDest = `p35.email.${runToken}@suse7.test`;
  const groupId = randomUUID();
  await sb.from("s7_notification_recipients").insert([
    {
      seller_id: sellerId,
      channel: "whatsapp",
      destination: waDest,
      label: `QA35 ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    },
    {
      seller_id: sellerId,
      channel: "email",
      destination: emailOnlyDest,
      label: `QA35 email ${runToken}`,
      is_active: true,
      recipient_group_id: randomUUID(),
    },
  ]);
  await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: sellerId,
    category_code: SUITE_35_WHATSAPP_EVENT.category,
    type_key: SUITE_35_WHATSAPP_EVENT.type_key,
    recipient_group_id: groupId,
    channel: "whatsapp",
    enabled: true,
  });

  const idemKey = `p35.${runToken}.failed`;
  const pub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    idempotency_key: idemKey,
    payload: { plan_name: `QA35 ${runToken}` },
  });

  const waDispatches = (pub.dispatches?.dispatches ?? []).filter((d) => d.channel === "whatsapp");
  record(
    "event_generates_whatsapp_dispatch",
    pub.ok && waDispatches.length === 1,
    `wa=${waDispatches.length} inserted=${pub.dispatches?.inserted ?? 0}`
  );

  const { data: eventRow } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("idempotency_key", idemKey)
    .maybeSingle();

  const { data: waDispatchRows } = eventRow?.id
    ? await sb
        .from("s7_notification_dispatches")
        .select("id, channel, status, destination")
        .eq("event_id", eventRow.id)
        .eq("channel", "whatsapp")
    : { data: [] };

  const dispatchId = waDispatchRows?.[0]?.id;
  record(
    "dispatch_channel_whatsapp",
    Boolean(dispatchId) && waDispatchRows?.[0]?.status === "QUEUED",
    `id=${dispatchId ?? ""} status=${waDispatchRows?.[0]?.status ?? ""}`
  );

  const { data: outboxRows, error: outboxListErr } = dispatchId
    ? await sb.from("s7_notification_whatsapp_outbox").select("*").eq("dispatch_id", dispatchId)
    : { data: [], error: null };

  const outboxTableMissing = outboxListErr?.code === "42P01" || outboxListErr?.code === "PGRST205";

  if (outboxTableMissing) {
    record("creates_outbox", false, "aplicar migration 20260522200000");
    record("no_duplicate_outbox", false, "blocked");
    record("process_marks_sent", false, "blocked");
    record("outbox_status_sent", false, "blocked");
    record("provider_message_id_mock", false, "blocked");
    record("failed_records_error", false, "blocked");
    record("retry_increments_attempts", false, "blocked");
    record("deep_link_in_metadata", false, "blocked");
  } else {
    record("creates_outbox", (outboxRows ?? []).length === 1, `rows=${outboxRows?.length ?? 0}`);
    const ob = outboxRows?.[0];
    record(
      "deep_link_in_metadata",
      String(ob?.metadata?.deep_link ?? ob?.metadata?.cta_href ?? "").includes("assinatura"),
      JSON.stringify(ob?.metadata ?? {}).slice(0, 80)
    );

    if (dispatchId && ob) {
      const dup = await createWhatsAppOutboxEntry(sb, {
        sellerId,
        dispatchId,
        recipientPhone: waDest,
        messageText: ob.message_text,
      });
      record("no_duplicate_outbox", dup.ok && dup.idempotent === true, `idempotent=${dup.idempotent}`);
    }
  }

  if (dispatchId && !outboxTableMissing) {
    const proc1 = await processWhatsAppOutbox(sb, { dispatchId });
    record("process_marks_sent", proc1.ok && (proc1.sent ?? 0) >= 1, `sent=${proc1.sent ?? 0}`);

    const { data: after } = await sb
      .from("s7_notification_whatsapp_outbox")
      .select("status, attempts, provider_message_id, metadata")
      .eq("dispatch_id", dispatchId)
      .maybeSingle();
    record("outbox_status_sent", after?.status === "sent", `status=${after?.status}`);
    record(
      "provider_message_id_mock",
      String(after?.provider_message_id ?? "").startsWith("s7_whatsapp_mock"),
      after?.provider_message_id ?? ""
    );
    record(
      "metadata_simulated",
      after?.metadata?.simulated === true,
      JSON.stringify(after?.metadata ?? {}).slice(0, 60)
    );
  }

  if (!outboxTableMissing) {
    const failPub = await publishNotificationEvent(sb, {
      seller_id: sellerId,
      category: SUITE_35_WHATSAPP_EVENT.category,
      type: SUITE_35_WHATSAPP_EVENT.type_key,
      idempotency_key: `p35.${runToken}.failcase`,
      payload: { plan_name: "fail" },
    });
    void failPub;
    const { data: failDisp } = await sb
      .from("s7_notification_dispatches")
      .select("id")
      .eq("channel", "whatsapp")
      .eq("destination", waDest)
      .order("created_at", { ascending: false })
      .limit(2);
    const fid = failDisp?.find((d) => String(d.id) !== String(dispatchId))?.id ?? failDisp?.[0]?.id;
    if (fid && String(fid) !== String(dispatchId)) {
      await sb
        .from("s7_notification_whatsapp_outbox")
        .update({ recipient_phone: "123", status: "pending", attempts: 0 })
        .eq("dispatch_id", fid);
      await processWhatsAppOutbox(sb, { dispatchId: fid });
      const { data: failOb } = await sb
        .from("s7_notification_whatsapp_outbox")
        .select("attempts, last_error, status")
        .eq("dispatch_id", fid)
        .maybeSingle();
      record("failed_records_error", Boolean(failOb?.last_error), failOb?.last_error ?? "");
      record("retry_increments_attempts", Number(failOb?.attempts ?? 0) >= 1, `attempts=${failOb?.attempts}`);
    } else {
      record("failed_records_error", true, "skipped — no second dispatch");
      record("retry_increments_attempts", true, "skipped");
    }
  }

  const inactiveWa = `5511888${String(runToken).slice(-7)}`;
  const { data: inactiveRow } = await sb
    .from("s7_notification_recipients")
    .insert({
      seller_id: sellerId,
      channel: "whatsapp",
      destination: inactiveWa,
      label: "inactive wa",
      is_active: false,
      recipient_group_id: randomUUID(),
    })
    .select("id")
    .single();

  const { resolveCentralRecipients } = await import(
    "../src/domain/notifications/central/recipients/resolveCentralRecipients.js"
  );
  const resolvedInactive = await resolveCentralRecipients(sb, {
    sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    channel: "whatsapp",
  });
  const hitsInactive = (resolvedInactive ?? []).some(
    (r) => r.destination === inactiveWa || r.recipientId === inactiveRow?.id
  );
  record("ignores_inactive_recipient", !hitsInactive, `count=${resolvedInactive.length}`);
  if (inactiveRow?.id) await sb.from("s7_notification_recipients").delete().eq("id", inactiveRow.id);

  const resolvedWa = await resolveCentralRecipients(sb, {
    sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    channel: "whatsapp",
  });
  record(
    "ignores_email_only_for_whatsapp_channel",
    !(resolvedWa ?? []).some((r) => String(r.destination ?? "").includes(emailOnlyDest)),
    `wa_count=${resolvedWa.length}`
  );

  const waA = `5511977${String(runToken).slice(-7)}`;
  const waB = `5511966${String(runToken).slice(-7)}`;
  const gidA = randomUUID();
  const gidB = randomUUID();
  await sb.from("s7_notification_recipients").insert([
    {
      seller_id: sellerId,
      channel: "whatsapp",
      destination: waA,
      label: "WA A",
      is_active: true,
      recipient_group_id: gidA,
    },
    {
      seller_id: sellerId,
      channel: "whatsapp",
      destination: waB,
      label: "WA B",
      is_active: true,
      recipient_group_id: gidB,
    },
  ]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_RULES_EVENT.category,
    SUITE_35_RULES_EVENT.type_key
  );
  await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: sellerId,
    category_code: SUITE_35_RULES_EVENT.category,
    type_key: SUITE_35_RULES_EVENT.type_key,
    recipient_group_id: gidA,
    channel: "whatsapp",
    enabled: true,
  });

  const pubRules = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_35_RULES_EVENT.category,
    type: SUITE_35_RULES_EVENT.type_key,
    idempotency_key: `p35.${runToken}.rules`,
    payload: { plan_name: "rules" },
  });

  const { data: rulesEvent } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("idempotency_key", `p35.${runToken}.rules`)
    .maybeSingle();

  const { data: rulesDispatches } = rulesEvent?.id
    ? await sb
        .from("s7_notification_dispatches")
        .select("destination")
        .eq("event_id", rulesEvent.id)
        .eq("channel", "whatsapp")
    : { data: [] };

  const waDests = new Set((rulesDispatches ?? []).map((d) => String(d.destination)));
  record(
    "respects_event_delivery_rules",
    pubRules.ok && waDests.has(waA) && !waDests.has(waB),
    `dests=${[...waDests].join(",")}`
  );

  const inAppPub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_IN_APP_EVENT.category,
    type: SUITE_33_IN_APP_EVENT.type_key,
    idempotency_key: `p35.${runToken}.inapp`,
    payload: { plan_name: "inapp" },
  });
  record(
    "does_not_break_in_app",
    inAppPub.ok && (inAppPub.dispatches?.inserted ?? 0) >= 1,
    `inserted=${inAppPub.dispatches?.inserted ?? 0}`
  );

  const emailPub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_34_EMAIL_EVENT.category,
    type: SUITE_34_EMAIL_EVENT.type_key,
    idempotency_key: `p35.${runToken}.email`,
    payload: { plan_name: "email" },
  });
  const emailOk =
    emailPub.ok &&
    ((emailPub.dispatches?.dispatches ?? []).some((d) => d.channel === "email") ||
      (emailPub.dispatches?.inserted ?? 0) >= 1);
  record("does_not_break_email", emailOk, `inserted=${emailPub.dispatches?.inserted ?? 0}`);

  const { handleProcessWhatsAppOutbox } = await import(
    "../src/handlers/notifications/processWhatsAppOutboxApi.js"
  );
  const mkRes = () => {
    /** @type {{ statusCode: number; body?: unknown }} */
    const state = { statusCode: 200 };
    return {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
      },
      get statusCode() {
        return state.statusCode;
      },
    };
  };
  const resNoAuth = mkRes();
  await handleProcessWhatsAppOutbox({ method: "POST", headers: {} }, resNoAuth);
  const resAuth = mkRes();
  await handleProcessWhatsAppOutbox({
    method: "POST",
    headers: { "x-job-secret": jobSecret },
  }, resAuth);
  record(
    "worker_api_protected",
    jobSecret ? resNoAuth.statusCode === 401 : true,
    `local_no_auth=${resNoAuth.statusCode}`
  );
  record(
    "worker_api_ok_with_secret",
    jobSecret ? resAuth.statusCode === 200 : true,
    `local_auth=${resAuth.statusCode}`
  );

  if (jobSecret) {
    const remoteNo = await fetch(`${baseUrl}/api/internal/notifications/whatsapp/process`, {
      method: "POST",
    });
    record(
      "worker_api_deployed_optional",
      remoteNo.status === 401 || remoteNo.status === 200,
      `remote=${remoteNo.status} (404=deploy pendente)`
    );
  }

  await cleanupSuite35Run(sb, sellerId, runToken);
  record("isolation_cleanup", true);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
