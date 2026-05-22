#!/usr/bin/env node
/**
 * Fase 3.5B — WhatsApp sandbox / test lab
 * node scripts/validatePhase35BWhatsAppSandbox.mjs
 */

process.env.S7_WHATSAPP_MODE = process.env.S7_WHATSAPP_MODE || "dev_sandbox";
process.env.S7_WHATSAPP_SANDBOX_WHITELIST =
  process.env.S7_WHATSAPP_SANDBOX_WHITELIST || "5511999999999";

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  SUITE_35_WHATSAPP_EVENT,
  cleanupSuite35bRun,
  prepareSuite35bIsolation,
  purgeEventDeliveryRulesForEvent,
  purgeRecipientsByDestinationHints,
  resolveSellerIdByEmail,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const WHITELIST_PHONE = String(process.env.S7_WHATSAPP_SANDBOX_WHITELIST || "5511999999999").replace(
  /\D/g,
  ""
);
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";

const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Fase 3.5B — WhatsApp Sandbox ===\n");

  const {
    getWhatsAppSandboxWhitelist,
    isDevSandboxWhatsAppMode,
    isPhoneSandboxWhitelisted,
  } = await import("../src/domain/notifications/central/whatsapp/whatsappSandboxPolicy.js");
  const { renderNotificationWhatsAppSandboxTemplate } = await import(
    "../src/domain/notifications/central/whatsapp/renderNotificationWhatsAppSandboxTemplate.js"
  );
  const { sendS7WhatsApp, isRealWhatsAppProviderConfigured } = await import(
    "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js"
  );

  record("dev_sandbox_mode", isDevSandboxWhatsAppMode(), process.env.S7_WHATSAPP_MODE);
  record(
    "whitelist_configured",
    getWhatsAppSandboxWhitelist().includes(WHITELIST_PHONE),
    getWhatsAppSandboxWhitelist().join(",")
  );
  record("no_real_provider", !isRealWhatsAppProviderConfigured(), "");

  const tpl = renderNotificationWhatsAppSandboxTemplate({
    category: "PROFIT",
    type: "NEGATIVE_MARGIN",
    title: "Venda com prejuízo — Kit",
    message: "Venda com margem negativa detectada no item Kit Premium.",
    payload: {},
  });
  record(
    "sandbox_template_structure",
    tpl.message_text.includes("Suse7") &&
      tpl.message_text.includes("Abra:") &&
      !tpl.message_text.includes("<") &&
      tpl.char_count <= 4096,
    `${tpl.char_count} chars`
  );
  record(
    "sandbox_template_ideal_length",
    tpl.char_count <= 500,
    `ideal<=500 actual=${tpl.char_count}`
  );

  const blocked = await sendS7WhatsApp({ to: "5511000000001", message: "bloqueio teste" });
  record("blocked_non_whitelist", blocked.blocked === true && blocked.error === "NOT_WHITELISTED", blocked.error ?? "");

  const allowed = await sendS7WhatsApp({ to: WHITELIST_PHONE, message: "ok teste whitelist" });
  record(
    "whitelist_allows_mock",
    allowed.ok && allowed.simulated === true,
    allowed.providerMessageId ?? ""
  );

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    record("supabase_env", false);
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const sellerId = await resolveSellerIdByEmail(sb, testEmail);
  const runToken = String(Date.now());
  await prepareSuite35bIsolation(sb, sellerId, runToken);
  await purgeEventDeliveryRulesForEvent(
    sb,
    sellerId,
    SUITE_35_WHATSAPP_EVENT.category,
    SUITE_35_WHATSAPP_EVENT.type_key
  );
  const waDest = WHITELIST_PHONE;
  await purgeRecipientsByDestinationHints(sb, sellerId, [WHITELIST_PHONE, `p35b.${runToken}`]);

  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { processWhatsAppOutbox } = await import(
    "../src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js"
  );

  const groupId = randomUUID();
  const { data: existingRecipient } = await sb
    .from("s7_notification_recipients")
    .select("id, recipient_group_id")
    .eq("seller_id", sellerId)
    .eq("channel", "whatsapp")
    .eq("destination", waDest)
    .maybeSingle();

  if (existingRecipient?.id) {
    const { error: updateErr } = await sb
      .from("s7_notification_recipients")
      .update({
        label: `p35b ${runToken}`,
        is_active: true,
        recipient_group_id: groupId,
      })
      .eq("id", existingRecipient.id);
    if (updateErr) {
      record("recipient_reuse", false, updateErr.message);
      process.exit(1);
    }
  } else {
    const { error: recipientErr } = await sb.from("s7_notification_recipients").insert({
      seller_id: sellerId,
      channel: "whatsapp",
      destination: waDest,
      label: `p35b ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    });
    if (recipientErr) {
      record("recipient_insert", false, recipientErr.message);
      process.exit(1);
    }
  }

  const { error: ruleErr } = await sb.from("s7_notification_event_delivery_rules").upsert(
    {
      seller_id: sellerId,
      category_code: SUITE_35_WHATSAPP_EVENT.category,
      type_key: SUITE_35_WHATSAPP_EVENT.type_key,
      channel: "whatsapp",
      recipient_group_id: groupId,
      enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "seller_id,category_code,type_key,channel,recipient_group_id" }
  );
  if (ruleErr) {
    record("delivery_rule_insert", false, ruleErr.message);
    process.exit(1);
  }
  record("recipient_ready", true, existingRecipient?.id ? "reused" : "inserted");

  const { resolveCentralRecipients } = await import(
    "../src/domain/notifications/central/recipients/resolveCentralRecipients.js"
  );
  const resolvedBefore = await resolveCentralRecipients(sb, {
    sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    channel: "whatsapp",
  });
  record(
    "recipients_resolved_before_publish",
    (resolvedBefore ?? []).some((r) => String(r.destination ?? "").replace(/\D/g, "") === waDest),
    `count=${resolvedBefore?.length ?? 0}`
  );

  const pub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_35_WHATSAPP_EVENT.category,
    type: SUITE_35_WHATSAPP_EVENT.type_key,
    idempotency_key: `p35b.${runToken}.pipe`,
    payload: { plan_name: "Sandbox 3.5B" },
    force_redispatch: true,
  });

  const wa = (pub.dispatches?.dispatches ?? []).find((d) => d.channel === "whatsapp");
  const dispatchId = String(wa?.dispatchId ?? "");
  record("pipeline_whatsapp_dispatch", Boolean(dispatchId), `status=${wa?.status ?? ""}`);
  record("pipeline_queued", wa?.status === "QUEUED", wa?.status ?? "");

  const { data: ob } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("id, status, message_text, metadata")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();
  record("outbox_created", Boolean(ob?.id), `status=${ob?.status}`);
  record(
    "outbox_sandbox_variant",
    ob?.metadata?.template_variant === "sandbox_35b",
    ob?.metadata?.template_variant ?? ""
  );

  const proc = dispatchId
    ? await processWhatsAppOutbox(sb, { dispatchId })
    : { ok: false, sent: 0 };
  record("worker_process", proc.ok && (proc.sent ?? 0) >= 1, `sent=${proc.sent}`);

  const { data: after } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("status, provider_message_id, metadata")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();
  record("outbox_sent_simulated", after?.status === "sent" && after?.metadata?.simulated === true, after?.status ?? "");
  record(
    "provider_mock_id",
    String(after?.provider_message_id ?? "").startsWith("s7_whatsapp_mock"),
    after?.provider_message_id ?? ""
  );

  record(
    "preserves_35a_mock_default",
    isPhoneSandboxWhitelisted(waDest) && !isRealWhatsAppProviderConfigured(),
    "3.5A compat"
  );

  await cleanupSuite35bRun(sb, sellerId, runToken);
  record("isolation_cleanup", true);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
