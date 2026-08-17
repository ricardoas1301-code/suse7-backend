#!/usr/bin/env node
/**
 * Smoke E2E — worker e-mail MOCK (Fase 3.4)
 * node scripts/smokePhase34EmailWorker.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { publishNotificationEvent } from "../src/domain/notifications/central/events/publishNotificationEvent.js";
import { processEmailOutbox } from "../src/domain/notifications/central/email/processEmailOutbox.js";
import { isRealEmailProviderConfigured } from "../src/domain/notifications/central/email/S7EmailProvider.js";
import { resolveSellerIdByEmail } from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || serviceKey;
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";
const jobSecret = process.env.JOB_SECRET?.trim() || "";

const runToken = String(Date.now());
const smokeEmail = `smoke.p34.${runToken}@suse7.test`;
const idemKey = `p34.smoke.${runToken}`;

function step(name, pass, detail = "") {
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

async function login() {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const json = await res.json();
  return json.access_token ?? null;
}

async function main() {
  console.log("=== Smoke Fase 3.4 — Worker e-mail MOCK ===\n");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const sellerId = await resolveSellerIdByEmail(sb, testEmail);
  const groupId = randomUUID();

  await sb.from("s7_notification_event_delivery_rules").delete().eq("seller_id", sellerId).eq("category_code", "BILLING").eq("type_key", "PAYMENT_CONFIRMED");
  await sb.from("s7_notification_recipients").delete().eq("seller_id", sellerId).eq("destination", smokeEmail);

  await sb.from("s7_notification_recipients").insert([
    { seller_id: sellerId, channel: "email", destination: smokeEmail, label: "Smoke P34", is_active: true, recipient_group_id: groupId },
    { seller_id: sellerId, channel: "whatsapp", destination: `5511866${String(runToken).slice(-7)}`, label: "Smoke P34", is_active: true, recipient_group_id: groupId },
  ]);
  await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: sellerId,
    category_code: "BILLING",
    type_key: "PAYMENT_CONFIRMED",
    recipient_group_id: groupId,
    channel: "email",
    enabled: true,
  });

  const pub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: "BILLING",
    type: "PAYMENT_CONFIRMED",
    idempotency_key: idemKey,
    payload: { plan_name: `Smoke ${runToken}` },
  });

  const { data: eventRow } = await sb.from("s7_notification_events").select("id").eq("idempotency_key", idemKey).maybeSingle();
  const { data: dispatches } = await sb
    .from("s7_notification_dispatches")
    .select("id, channel, status, destination")
    .eq("event_id", eventRow?.id)
    .eq("channel", "email")
    .eq("destination", smokeEmail);

  const dispatch = dispatches?.[0];
  step("1_event_with_email_recipient", pub.ok && Boolean(dispatch?.id));
  step("2_dispatch_email_queued", dispatch?.status === "QUEUED", `status=${dispatch?.status}`);

  const { data: outboxBefore } = await sb
    .from("s7_notification_email_outbox")
    .select("id, status, dispatch_id, recipient_email")
    .eq("dispatch_id", dispatch?.id)
    .maybeSingle();

  step("3_outbox_pending", outboxBefore?.status === "pending", `status=${outboxBefore?.status}`);

  const procLocal = await processEmailOutbox(sb, { dispatchId: dispatch?.id });
  step("4_worker_local_ok", procLocal.ok && (procLocal.sent ?? 0) >= 1, `sent=${procLocal.sent}`);

  const { data: outboxAfter } = await sb
    .from("s7_notification_email_outbox")
    .select("status, provider_message_id, metadata, attempts")
    .eq("dispatch_id", dispatch?.id)
    .maybeSingle();

  const { data: dispatchAfter } = await sb
    .from("s7_notification_dispatches")
    .select("status, provider_key")
    .eq("id", dispatch?.id)
    .maybeSingle();

  const mockId = String(outboxAfter?.provider_message_id ?? "");
  const simulated = outboxAfter?.metadata?.simulated === true || mockId.startsWith("s7_mock_");

  step("5_outbox_sent", outboxAfter?.status === "sent", `status=${outboxAfter?.status}`);
  step("6_dispatch_sent", dispatchAfter?.status === "SENT", `status=${dispatchAfter?.status}`);
  step("7_provider_message_id_mock", mockId.startsWith("s7_mock_"), mockId);
  step("8_no_real_send_config", !isRealEmailProviderConfigured(), `isReal=${isRealEmailProviderConfigured()}`);
  step("9_metadata_simulated", simulated, JSON.stringify(outboxAfter?.metadata ?? {}));

  const token = await login();
  const inboxRes = await fetch(`${baseUrl}/api/notifications/inbox?limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const inboxJson = await inboxRes.json().catch(() => ({}));
  step("10_inbox_api_ok", inboxRes.status === 200 && Array.isArray(inboxJson.items), `status=${inboxRes.status}`);

  const workerRes = await fetch(`${baseUrl}/api/internal/notifications/email/process`, {
    method: "POST",
    headers: { "X-Job-Secret": jobSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ batch_size: 5 }),
  });
  const workerJson = await workerRes.json().catch(() => ({}));
  step("11_worker_api_ok", workerRes.status === 200 && workerJson.ok === true, `status=${workerRes.status}`);

  await sb.from("s7_notification_event_delivery_rules").delete().eq("seller_id", sellerId).eq("type_key", "PAYMENT_CONFIRMED").eq("recipient_group_id", groupId);
  await sb.from("s7_notification_recipients").delete().eq("seller_id", sellerId).eq("destination", smokeEmail);
  if (eventRow?.id) {
    const { data: d2 } = await sb.from("s7_notification_dispatches").select("id").eq("event_id", eventRow.id);
    const ids = (d2 ?? []).map((d) => d.id);
    if (ids.length) await sb.from("s7_notification_email_outbox").delete().in("dispatch_id", ids);
    await sb.from("s7_notification_dispatches").delete().eq("event_id", eventRow.id);
    await sb.from("s7_notification_events").delete().eq("id", eventRow.id);
  }

  console.log("\n=== Smoke concluído ===");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
