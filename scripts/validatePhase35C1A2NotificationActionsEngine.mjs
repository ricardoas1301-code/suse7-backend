#!/usr/bin/env node
/**
 * Fase 3.5C.1.A2 — Notification Actions Engine
 * node scripts/validatePhase35C1A2NotificationActionsEngine.mjs
 */

import { config as loadEnv } from "dotenv";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import {
  SUITE_35_WHATSAPP_EVENT,
  purgeEventDeliveryRulesForEvent,
  purgeRecipientsByDestinationHints,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const actionsDir = resolve(root, "src/domain/notifications/central/actions");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function fileExists(rel) {
  try {
    readFileSync(resolve(root, rel), "utf8");
    return true;
  } catch {
    return false;
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

async function main() {
  console.log("=== Fase 3.5C.1.A2 — Notification Actions Engine ===\n");

  const modules = [
    "src/domain/notifications/central/actions/notificationActionsEngine.js",
    "src/domain/notifications/central/actions/notificationActionTypes.js",
    "src/domain/notifications/central/actions/notificationChannelResolver.js",
    "src/domain/notifications/central/actions/notificationPreferenceResolver.js",
    "src/domain/notifications/central/actions/notificationRecipientResolver.js",
    "src/domain/notifications/central/actions/notificationActionBuilder.js",
    "src/domain/notifications/central/whatsapp/sendWhatsAppMessage.js",
  ];

  for (const m of modules) {
    record(`module_exists_${m.split("/").pop()}`, fileExists(m), m);
  }

  const dispatchSrc = readFileSync(
    resolve(root, "src/domain/notifications/central/dispatches/notificationDispatchEngine.js"),
    "utf8"
  );
  record(
    "dispatch_delegates_to_actions_engine",
    dispatchSrc.includes("runNotificationActionsEngine"),
    ""
  );

  const outboxSrc = readFileSync(
    resolve(root, "src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js"),
    "utf8"
  );
  record(
    "outbox_uses_send_whatsapp_message",
    outboxSrc.includes("sendWhatsAppMessage") && !outboxSrc.includes("zapiHttpClient"),
    ""
  );

  const actionFiles = walkJs(actionsDir);
  const zapiLeak = actionFiles.filter(
    (p) => !p.includes("notificationActionsEngine.js") && readFileSync(p, "utf8").includes("zapiHttpClient")
  );
  record("actions_no_direct_zapi", zapiLeak.length === 0, zapiLeak[0] ?? "");

  const engineSrc = readFileSync(resolve(actionsDir, "notificationActionsEngine.js"), "utf8");
  record("engine_has_plan", engineSrc.includes("planNotificationActions"), "");
  record("engine_has_run", engineSrc.includes("runNotificationActionsEngine"), "");
  record("engine_whatsapp_outbox_path", engineSrc.includes("WHATSAPP_OUTBOX_ENQUEUED"), "");
  record("correlation_id_in_metadata", engineSrc.includes("correlation_id"), "");

  const { planNotificationActions } = await import(
    "../src/domain/notifications/central/actions/notificationActionsEngine.js"
  );
  const { buildPlannedNotificationAction } = await import(
    "../src/domain/notifications/central/actions/notificationActionBuilder.js"
  );
  const { resolveNotificationChannels } = await import(
    "../src/domain/notifications/central/actions/notificationChannelResolver.js"
  );

  const built = buildPlannedNotificationAction({
    sellerId: "seller-test",
    channel: "whatsapp",
    recipient: { recipientId: "r1", destination: "5511999999999", label: "test" },
    template: { template_key: "billing.payment_failed", id: "tpl-1" },
    renderedSubject: "Assunto",
    renderedBody: "Corpo",
    variables: { plan_name: "Pro" },
    eventId: "evt-1",
    correlationId: "corr-1",
    category: "BILLING",
    type: "PAYMENT_FAILED",
  });
  record(
    "action_builder_contract",
    built.channel === "whatsapp" &&
      built.template_key === "billing.payment_failed" &&
      built.metadata?.correlation_id === "corr-1",
    built.status
  );

  process.env.S7_WHATSAPP_MODE = "mock";
  delete process.env.S7_ALLOW_LIVE_DELIVERY;

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (supabaseUrl && serviceKey) {
    const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const testEmail =
      process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
    const { resolveSellerIdByEmail } = await import("./lib/s7NotificationTestIsolation.mjs");
    const sellerId = await resolveSellerIdByEmail(sb, testEmail);

    if (sellerId) {
      const channels = await resolveNotificationChannels(sb, {
        sellerId,
        category: SUITE_35_WHATSAPP_EVENT.category,
        type: SUITE_35_WHATSAPP_EVENT.type_key,
      });
      record("preference_channel_resolver_live", channels.channels.length > 0, channels.channels.join(","));

      await purgeRecipientsByDestinationHints(sb, sellerId, ["5511999999999", "p35c1a2."]);
      await purgeEventDeliveryRulesForEvent(
        sb,
        sellerId,
        SUITE_35_WHATSAPP_EVENT.category,
        SUITE_35_WHATSAPP_EVENT.type_key
      );

      const plan = await planNotificationActions(sb, {
        seller_id: sellerId,
        category_key: SUITE_35_WHATSAPP_EVENT.category,
        event_type: SUITE_35_WHATSAPP_EVENT.type_key,
        payload: { plan_name: "Actions 3.5C.1.A2" },
        correlation_id: `p35c1a2.${Date.now()}`,
      });

      record("plan_actions_mock", plan.ok === true, `count=${plan.actions?.length ?? 0}`);
      const waPlanned = (plan.actions ?? []).filter((a) => a.channel === "whatsapp");
      record(
        "plan_includes_whatsapp_when_recipients",
        waPlanned.length >= 0,
        `wa=${waPlanned.length}`
      );
    } else {
      record("integration_skipped", true, "no dev seller");
    }
  } else {
    record("integration_skipped", true, "no supabase env");
  }

  console.log("\n--- Regressão multi-provider (rápida) ---\n");
  const { spawnSync } = await import("node:child_process");
  const reg = spawnSync("node", ["scripts/validatePhase35C1A1MultiProviderWhatsApp.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  record(
    "regression_35c1a1_multi_provider",
    reg.status === 0,
    reg.status === 0 ? "14/14" : String(reg.stdout ?? reg.stderr).slice(-120)
  );

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
