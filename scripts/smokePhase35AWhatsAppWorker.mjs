#!/usr/bin/env node
/**
 * Smoke E2E — worker WhatsApp MOCK (Fase 3.5A)
 * node scripts/smokePhase35AWhatsAppWorker.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { publishNotificationEvent } from "../src/domain/notifications/central/events/publishNotificationEvent.js";
import { processWhatsAppOutbox } from "../src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js";
import { isRealWhatsAppProviderConfigured } from "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js";
import { resolveSellerIdByEmail } from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const jobSecret = process.env.JOB_SECRET?.trim() || "";

const runToken = String(Date.now());
const waPhone = `5511855${String(runToken).slice(-7)}`;
const idemKey = `p35.smoke.${runToken}`;

function step(name, pass, detail = "") {
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

async function main() {
  console.log("=== Smoke Fase 3.5A — Worker WhatsApp MOCK ===\n");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const sellerId = await resolveSellerIdByEmail(sb, testEmail);
  const groupId = randomUUID();

  await sb
    .from("s7_notification_event_delivery_rules")
    .delete()
    .eq("seller_id", sellerId)
    .eq("category_code", "BILLING")
    .eq("type_key", "PAYMENT_FAILED");
  await sb.from("s7_notification_recipients").delete().eq("seller_id", sellerId).eq("destination", waPhone);

  await sb.from("s7_notification_recipients").insert({
    seller_id: sellerId,
    channel: "whatsapp",
    destination: waPhone,
    label: `Smoke P35A ${runToken}`,
    is_active: true,
    recipient_group_id: groupId,
  });
  await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: sellerId,
    category_code: "BILLING",
    type_key: "PAYMENT_FAILED",
    recipient_group_id: groupId,
    channel: "whatsapp",
    enabled: true,
  });

  const pub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: "BILLING",
    type: "PAYMENT_FAILED",
    idempotency_key: idemKey,
    payload: { plan_name: `Smoke WA ${runToken}` },
  });

  const { data: eventRow } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("idempotency_key", idemKey)
    .maybeSingle();

  const { data: dispatches } = await sb
    .from("s7_notification_dispatches")
    .select("id, channel, status, destination")
    .eq("event_id", eventRow?.id ?? "")
    .eq("channel", "whatsapp");

  const waDispatch = dispatches?.[0];
  step("1_event_whatsapp_enabled", pub.ok && Boolean(waDispatch), `inserted=${pub.dispatches?.inserted ?? 0}`);
  step("2_dispatch_whatsapp", waDispatch?.channel === "whatsapp", waDispatch?.channel ?? "");
  step("3_dispatch_queued", waDispatch?.status === "QUEUED", `status=${waDispatch?.status ?? ""}`);

  const { data: outboxBefore } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("id, status, recipient_phone, message_text")
    .eq("dispatch_id", waDispatch?.id ?? "")
    .maybeSingle();

  step("4_outbox_row", Boolean(outboxBefore?.id), `id=${outboxBefore?.id ?? ""}`);
  step("5_outbox_pending", outboxBefore?.status === "pending", `status=${outboxBefore?.status ?? ""}`);

  const proc = await processWhatsAppOutbox(sb, { dispatchId: waDispatch?.id });
  step("6_worker_ok", proc.ok && (proc.sent ?? 0) >= 1, `sent=${proc.sent ?? 0}`);

  const { data: outboxAfter } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("status, provider_message_id, metadata")
    .eq("dispatch_id", waDispatch?.id ?? "")
    .maybeSingle();

  const { data: dispatchAfter } = await sb
    .from("s7_notification_dispatches")
    .select("status, provider_key")
    .eq("id", waDispatch?.id ?? "")
    .maybeSingle();

  step("7_outbox_sent", outboxAfter?.status === "sent", `status=${outboxAfter?.status ?? ""}`);
  step("8_dispatch_sent", dispatchAfter?.status === "SENT", `status=${dispatchAfter?.status ?? ""}`);
  step(
    "9_provider_message_id_mock",
    String(outboxAfter?.provider_message_id ?? "").startsWith("s7_whatsapp_mock"),
    outboxAfter?.provider_message_id ?? ""
  );
  step("10_metadata_simulated", outboxAfter?.metadata?.simulated === true, JSON.stringify(outboxAfter?.metadata ?? {}));
  step("11_no_real_provider", !isRealWhatsAppProviderConfigured(), `isReal=${isRealWhatsAppProviderConfigured()}`);

  if (jobSecret) {
    const apiRes = await fetch(`${baseUrl}/api/internal/notifications/whatsapp/process`, {
      method: "POST",
      headers: { "X-Job-Secret": jobSecret },
    });
    step("12_worker_api_remote", apiRes.status === 200, `status=${apiRes.status}`);
  }

  await sb.from("s7_notification_recipients").delete().eq("seller_id", sellerId).eq("destination", waPhone);
  await sb
    .from("s7_notification_event_delivery_rules")
    .delete()
    .eq("seller_id", sellerId)
    .eq("recipient_group_id", groupId);

  console.log("\n=== Smoke concluído ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
