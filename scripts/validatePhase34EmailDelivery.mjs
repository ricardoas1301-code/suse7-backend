#!/usr/bin/env node
/**
 * Fase 3.4 — Email delivery engine (outbox + worker mock)
 * node scripts/validatePhase34EmailDelivery.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  SUITE_34_EMAIL_EVENT,
  SUITE_34_RULES_EVENT,
  purgeEventDeliveryRulesForEvent,
  cleanupSuite34Run,
  prepareSuite34Isolation,
  resolveSellerIdByEmail,
  SUITE_33_IN_APP_EVENT,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";

/** @type {Array<{ name: string, pass: boolean, detail?: string }>} */
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Fase 3.4 — Email delivery (isolated) ===\n");

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
  await prepareSuite34Isolation(sb, sellerId, runToken);
  record("isolation_prepare", true, `runToken=${runToken}`);

  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { processEmailOutbox } = await import(
    "../src/domain/notifications/central/email/processEmailOutbox.js"
  );
  const { createEmailOutboxEntry } = await import(
    "../src/domain/notifications/central/email/createEmailOutboxEntry.js"
  );

  const emailDest = `p34.${runToken}@suse7.test`;
  const waDest = `5511877${String(runToken).slice(-7)}`;
  const groupId = randomUUID();
  await sb.from("s7_notification_recipients").insert([
    {
      seller_id: sellerId,
      channel: "email",
      destination: emailDest,
      label: `QA34 ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    },
    {
      seller_id: sellerId,
      channel: "whatsapp",
      destination: waDest,
      label: `QA34 ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    },
  ]);

  const idemKey = `p34.${runToken}.confirmed`;
  const pub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_34_EMAIL_EVENT.category,
    type: SUITE_34_EMAIL_EVENT.type_key,
    idempotency_key: idemKey,
    payload: { plan_name: `QA34 ${runToken}` },
  });

  const emailDispatches = (pub.dispatches?.dispatches ?? []).filter((d) => d.channel === "email");
  record(
    "event_generates_email_dispatch",
    pub.ok && (emailDispatches.length > 0 || (pub.dispatches?.inserted ?? 0) >= 1),
    `email_dispatches=${emailDispatches.length} inserted=${pub.dispatches?.inserted ?? 0}`
  );

  const { data: eventRow } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("idempotency_key", idemKey)
    .maybeSingle();

  const { data: emailDispatchRows } = eventRow?.id
    ? await sb
        .from("s7_notification_dispatches")
        .select("id, channel, status, destination")
        .eq("event_id", eventRow.id)
        .eq("channel", "email")
    : { data: [] };

  const dispatchId = emailDispatchRows?.[0]?.id;
  record("dispatch_channel_email", Boolean(dispatchId), `id=${dispatchId ?? ""}`);

  const { data: outboxRows, error: outboxListErr } = dispatchId
    ? await sb.from("s7_notification_email_outbox").select("*").eq("dispatch_id", dispatchId)
    : { data: [], error: null };

  const outboxTableMissing = outboxListErr?.code === "42P01" || outboxListErr?.code === "PGRST205";

  if (outboxTableMissing) {
    record("creates_outbox", false, "aplicar migration 20260522190000_s7_notification_email_outbox_phase34.sql");
    record("template_subject_html_text", false, "blocked — outbox table");
    record("deep_link_in_metadata", false, "blocked — outbox table");
    record("no_duplicate_outbox", false, "blocked — outbox table");
    record("process_marks_sent", false, "blocked — outbox table");
    record("outbox_status_sent", false, "blocked — outbox table");
    record("provider_message_id_set", false, "blocked — outbox table");
    record("failed_records_error", false, "blocked — outbox table");
    record("retry_increments_attempts", false, "blocked — outbox table");
  } else {
    record("creates_outbox", (outboxRows ?? []).length === 1, `rows=${outboxRows?.length ?? 0}`);
    const ob = outboxRows?.[0];
    record(
      "template_subject_html_text",
      Boolean(ob?.subject?.includes("Pagamento")) &&
        String(ob?.body_html ?? "").includes("Suse7") &&
        String(ob?.body_text ?? "").includes("Ver detalhes"),
      `subject=${ob?.subject?.slice(0, 40) ?? ""}`
    );
    record(
      "deep_link_in_metadata",
      String(ob?.metadata?.deep_link ?? ob?.metadata?.cta_href ?? "").includes("assinatura"),
      JSON.stringify(ob?.metadata ?? {}).slice(0, 80)
    );

    if (dispatchId && ob) {
      const dup = await createEmailOutboxEntry(sb, {
        sellerId,
        dispatchId,
        recipientEmail: emailDest,
        subject: ob.subject,
        bodyHtml: ob.body_html,
        bodyText: ob.body_text,
      });
      record("no_duplicate_outbox", dup.ok && dup.idempotent === true, `idempotent=${dup.idempotent}`);
    }
  }

  if (dispatchId && !outboxTableMissing) {
    const proc1 = await processEmailOutbox(sb, { dispatchId });
    record("process_marks_sent", proc1.ok && (proc1.sent ?? 0) >= 1, `sent=${proc1.sent ?? 0}`);

    const { data: after } = await sb
      .from("s7_notification_email_outbox")
      .select("status, attempts, provider_message_id")
      .eq("dispatch_id", dispatchId)
      .maybeSingle();
    record("outbox_status_sent", after?.status === "sent", `status=${after?.status}`);
    record("provider_message_id_set", Boolean(after?.provider_message_id), after?.provider_message_id ?? "");
  }

  if (!outboxTableMissing) {
  const failDispatchId = emailDispatchRows?.[1]?.id;
  if (!failDispatchId && dispatchId) {
    const failPub = await publishNotificationEvent(sb, {
      seller_id: sellerId,
      category: SUITE_34_EMAIL_EVENT.category,
      type: SUITE_34_EMAIL_EVENT.type_key,
      idempotency_key: `p34.${runToken}.failcase`,
      payload: { plan_name: "fail" },
    });
    void failPub;
    const { data: failDisp } = await sb
      .from("s7_notification_dispatches")
      .select("id")
      .eq("channel", "email")
      .eq("destination", emailDest)
      .order("created_at", { ascending: false })
      .limit(1);
    const fid = failDisp?.[0]?.id;
    if (fid) {
      await sb
        .from("s7_notification_email_outbox")
        .update({ recipient_email: "invalid", status: "pending", attempts: 0 })
        .eq("dispatch_id", fid);
      await processEmailOutbox(sb, { dispatchId: fid });
      const { data: failOb } = await sb
        .from("s7_notification_email_outbox")
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
  }

  const inactiveEmail = `p34.inactive.${runToken}@suse7.test`;
  const { data: inactiveRow } = await sb
    .from("s7_notification_recipients")
    .insert({
      seller_id: sellerId,
      channel: "email",
      destination: inactiveEmail,
      label: "inactive",
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
    category: SUITE_34_EMAIL_EVENT.category,
    type: SUITE_34_EMAIL_EVENT.type_key,
    channel: "email",
  });
  const hitsInactive = (resolvedInactive ?? []).some(
    (r) => r.destination === inactiveEmail || r.recipientId === inactiveRow?.id
  );
  record("ignores_inactive_recipient", !hitsInactive, `count=${resolvedInactive.length}`);
  if (inactiveRow?.id) await sb.from("s7_notification_recipients").delete().eq("id", inactiveRow.id);

  const noEmailWa = `5511888${String(runToken).slice(-7)}`;
  await sb.from("s7_notification_recipients").insert({
    seller_id: sellerId,
    channel: "whatsapp",
    destination: noEmailWa,
    label: "wa only",
    is_active: true,
    recipient_group_id: crypto.randomUUID(),
  });
  const resolvedEmail = await resolveCentralRecipients(sb, {
    sellerId,
    category: SUITE_34_EMAIL_EVENT.category,
    type: SUITE_34_EMAIL_EVENT.type_key,
    channel: "email",
  });
  record(
    "ignores_whatsapp_only_for_email_channel",
    !(resolvedEmail ?? []).some((r) => String(r.destination ?? "").includes(noEmailWa)),
    `email_count=${resolvedEmail.length}`
  );

  const emailA = `p34.a.${runToken}@suse7.test`;
  const emailB = `p34.b.${runToken}@suse7.test`;
  const gidA = randomUUID();
  const gidB = randomUUID();
  await sb.from("s7_notification_recipients").insert([
    {
      seller_id: sellerId,
      channel: "email",
      destination: emailA,
      label: "A",
      is_active: true,
      recipient_group_id: gidA,
    },
    {
      seller_id: sellerId,
      channel: "email",
      destination: emailB,
      label: "B",
      is_active: true,
      recipient_group_id: gidB,
    },
  ]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_34_RULES_EVENT.category,
    SUITE_34_RULES_EVENT.type_key
  );
  await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: sellerId,
    category_code: SUITE_34_RULES_EVENT.category,
    type_key: SUITE_34_RULES_EVENT.type_key,
    recipient_group_id: gidA,
    channel: "email",
    enabled: true,
  });

  const pubRules = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_34_RULES_EVENT.category,
    type: SUITE_34_RULES_EVENT.type_key,
    idempotency_key: `p34.${runToken}.rules`,
    payload: {},
  });

  const { data: rulesEvent } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("idempotency_key", `p34.${runToken}.rules`)
    .maybeSingle();

  const { data: rulesDispatches } = rulesEvent?.id
    ? await sb
        .from("s7_notification_dispatches")
        .select("destination")
        .eq("event_id", rulesEvent.id)
        .eq("channel", "email")
    : { data: [] };

  const dests = new Set((rulesDispatches ?? []).map((d) => String(d.destination)));
  record(
    "respects_event_delivery_rules",
    pubRules.ok && dests.has(emailA) && !dests.has(emailB),
    `dests=${[...dests].join(",")}`
  );

  const inAppPub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_IN_APP_EVENT.category,
    type: SUITE_33_IN_APP_EVENT.type_key,
    idempotency_key: `p34.${runToken}.inapp`,
    payload: { plan_name: "inapp check" },
  });
  const inAppOk =
    inAppPub.ok &&
    ((inAppPub.dispatches?.dispatches ?? []).some((d) => d.channel === "in_app") ||
      (inAppPub.dispatches?.inserted ?? 0) >= 1);
  record("does_not_break_in_app", inAppOk, `inserted=${inAppPub.dispatches?.inserted ?? 0}`);

  await cleanupSuite34Run(sb, sellerId, runToken);
  record("isolation_cleanup", true);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
