#!/usr/bin/env node
/**
 * S7 Mission Control — Fase 3.5C.1.A — Real Smoke Execution
 *
 * 1 seller · 1 phone · 1 dispatch · 1 mensagem real Z-API
 *
 * Pré-requisitos (.env.local):
 *   S7_WHATSAPP_PROVIDER=zapi
 *   S7_WHATSAPP_MODE=live
 *   S7_ALLOW_LIVE_DELIVERY=true
 *   S7_PROVIDER_SMOKE_ENABLED=true
 *   S7_ZAPI_SMOKE_RUN=true
 *   S7_ZAPI_BASE_URL=https://api.z-api.io/instances/.../token/...
 *   S7_PROVIDER_SMOKE_SELLER=<uuid>
 *   S7_PROVIDER_SMOKE_PHONE=5511...
 *
 * node scripts/runPhase35C1aRealSmokeExecution.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "path";
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

const REQUIRED = [
  ["S7_WHATSAPP_PROVIDER", "zapi"],
  ["S7_WHATSAPP_MODE", "live"],
  ["S7_ALLOW_LIVE_DELIVERY", "true"],
  ["S7_PROVIDER_SMOKE_ENABLED", "true"],
  ["S7_ZAPI_SMOKE_RUN", "true"],
  ["S7_ZAPI_BASE_URL", null],
  ["S7_PROVIDER_SMOKE_SELLER", null],
  ["S7_PROVIDER_SMOKE_PHONE", null],
];

/**
 * @returns {{ ok: boolean; failures: string[] }}
 */
function validatePreconditions() {
  const failures = [];
  for (const [key, expected] of REQUIRED) {
    const val = String(process.env[key] ?? "").trim();
    if (!val) {
      failures.push(`${key} missing`);
      continue;
    }
    if (expected != null && val.toLowerCase() !== expected) {
      failures.push(`${key} expected ${expected}, got ${val}`);
    }
  }
  if (String(process.env.S7_APP_ENV ?? process.env.NODE_ENV ?? "").toLowerCase() === "production") {
    failures.push("S7_APP_ENV must not be production for real smoke");
  }
  return { ok: failures.length === 0, failures };
}

function logStep(label, detail = "") {
  console.log(`${detail ? `${label} — ${detail}` : label}`);
}

async function main() {
  console.log("=== S7 Fase 3.5C.1.A — Real Smoke Execution ===\n");

  const pre = validatePreconditions();
  if (!pre.ok) {
    console.error("ABORT: pré-condições não atendidas:");
    for (const f of pre.failures) console.error(`  - ${f}`);
    process.exit(2);
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("ABORT: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  const smokeSeller = String(process.env.S7_PROVIDER_SMOKE_SELLER).trim();
  const smokePhone = String(process.env.S7_PROVIDER_SMOKE_PHONE).replace(/\D/g, "");
  const runToken = String(Date.now());

  const { ZapiWhatsAppAdapter } = await import(
    "../src/domain/notifications/central/providers/whatsapp/adapters/ZapiWhatsAppAdapter.js"
  );
  const adapter = new ZapiWhatsAppAdapter();

  const health = await adapter.health();
  logStep("health()", `${health.status} latency=${health.latency_ms}ms err=${health.error_code ?? ""}`);
  if (health.status !== "ok") {
    console.error("ABORT: instância Z-API não conectada (health)", {
      error_code: health.error_code,
      metadata: health.metadata,
    });
    if (health.error_code === "ZAPI_INSTANCE_NOT_FOUND") {
      console.error(
        "Dica: confira S7_ZAPI_BASE_URL = https://api.z-api.io/instances/{INSTANCE_ID}/token/{INSTANCE_TOKEN}",
        "(IDs do painel Instâncias — não confundir com Client-Token do header)"
      );
    }
    if (
      health.error_code === "ZAPI_CLIENT_TOKEN_NOT_CONFIGURED" ||
      String(health.error_code ?? "").includes("CLIENT-TOKEN")
    ) {
      console.error(
        "Dica: S7_ZAPI_TOKEN deve ser o Client-Token / Token de segurança da CONTA Z-API (painel Segurança),",
        "não o token da instância que já vai na URL (S7_ZAPI_BASE_URL)."
      );
    }
    process.exit(3);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: sellerRow } = await sb.from("profiles").select("id").eq("id", smokeSeller).maybeSingle();
  if (!sellerRow?.id) {
    const testEmail =
      process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
    const resolved = await resolveSellerIdByEmail(sb, testEmail);
    console.error(
      "ABORT: S7_PROVIDER_SMOKE_SELLER inválido.",
      `configured=${smokeSeller} dev_seller=${resolved ?? "null"}`
    );
    process.exit(2);
  }

  await purgeRecipientsByDestinationHints(sb, smokeSeller, [smokePhone, `p35c1a.${runToken}`]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    smokeSeller,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );

  const { data: existingRows } = await sb
    .from("s7_notification_recipients")
    .select("id, destination, recipient_group_id")
    .eq("seller_id", smokeSeller)
    .eq("channel", "whatsapp");

  const existingRecipient = (existingRows ?? []).find(
    (row) => String(row.destination ?? "").replace(/\D/g, "") === smokePhone
  );

  let groupId = randomUUID();
  if (existingRecipient?.id) {
    groupId = existingRecipient.recipient_group_id
      ? String(existingRecipient.recipient_group_id)
      : groupId;
    const { error: updateErr } = await sb
      .from("s7_notification_recipients")
      .update({
        is_active: true,
        recipient_group_id: groupId,
        label: `p35c1a smoke ${runToken}`,
      })
      .eq("id", existingRecipient.id);
    if (updateErr) {
      console.error("ABORT: falha ao atualizar recipient WhatsApp", updateErr.message);
      process.exit(2);
    }
    logStep("recipient", `reused id=${existingRecipient.id}`);
  } else {
    const { error: recipientErr } = await sb.from("s7_notification_recipients").insert({
      seller_id: smokeSeller,
      channel: "whatsapp",
      destination: smokePhone,
      label: `p35c1a smoke ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    });
    if (recipientErr) {
      console.error("ABORT: falha ao criar recipient WhatsApp", recipientErr.message);
      process.exit(2);
    }
    logStep("recipient", "created");
  }
  const { error: ruleErr } = await sb.from("s7_notification_event_delivery_rules").insert({
    seller_id: smokeSeller,
    category_code: SUITE_35_WHATSAPP_EVENT.category,
    type_key: SUITE_35_WHATSAPP_EVENT.type_key,
    channel: "whatsapp",
    recipient_group_id: groupId,
    enabled: true,
  });
  if (ruleErr) {
    console.error("ABORT: falha ao criar regra de entrega WhatsApp", ruleErr.message);
    process.exit(2);
  }

  const dispatchIdPlaceholder = randomUUID();
  const messageBody = [
    "[SUSE7]",
    "Smoke Test",
    "Provider=ZAPI",
    `Dispatch=${dispatchIdPlaceholder}`,
    `Timestamp=${new Date().toISOString()}`,
  ].join("\n");

  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { processWhatsAppOutbox } = await import(
    "../src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js"
  );

  const idemKey = `p35c1a.${runToken}.real`;
  const pub = await publishNotificationEvent(sb, {
    seller_id: smokeSeller,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    idempotency_key: idemKey,
    payload: { plan_name: "Smoke 3.5C.1.A", smoke_run: runToken },
    force_redispatch: true,
  });

  const wa = (pub.dispatches?.dispatches ?? []).find((d) => d.channel === "whatsapp");
  const dispatchId = String(wa?.dispatchId ?? "");
  if (!dispatchId) {
    console.error("ABORT: pipeline não gerou dispatch WhatsApp", pub);
    process.exit(4);
  }

  logStep("publish → dispatch", `dispatch_id=${dispatchId} status=${wa?.status ?? ""}`);

  const { data: obBefore } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("id, status, message_text")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();

  if (!obBefore?.id) {
    console.error("ABORT: outbox não criado");
    process.exit(4);
  }

  logStep("outbox", `id=${obBefore.id} status=${obBefore.status}`);

  const proc = await processWhatsAppOutbox(sb, { dispatchId });
  logStep("worker", `sent=${proc.sent} processed=${proc.processed} failed=${proc.failed}`);

  const { data: obAfter } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("status, provider_message_id, metadata, last_error, sent_at")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();

  const { data: dispAfter } = await sb
    .from("s7_notification_dispatches")
    .select("status, provider_key, sent_at")
    .eq("id", dispatchId)
    .maybeSingle();

  const success =
    (proc.sent ?? 0) >= 1 &&
    obAfter?.status === "sent" &&
    obAfter?.metadata?.simulated !== true &&
    String(obAfter?.provider_message_id ?? "").length > 0;

  const report = {
    run_token: runToken,
    dispatch_id: dispatchId,
    outbox_id: obBefore.id,
    outbox_status: obAfter?.status,
    provider_message_id: obAfter?.provider_message_id,
    dispatch_status: dispAfter?.status,
    provider_key: dispAfter?.provider_key,
    worker: proc,
    simulated: obAfter?.metadata?.simulated,
    provider_http_status: obAfter?.metadata?.http_status ?? null,
    last_error: obAfter?.last_error,
    success,
    message_preview: String(obAfter?.metadata?.logical_subject ?? "smoke").slice(0, 80),
  };

  console.log("\n--- Relatório 3.5C.1.A ---");
  console.log(JSON.stringify(report, null, 2));

  await purgeRecipientsByDestinationHints(sb, smokeSeller, [smokePhone, `p35c1a.${runToken}`]);
  await purgeEventDeliveryRulesForEvent(
    sb,
    smokeSeller,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );

  process.exit(success ? 0 : 5);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
