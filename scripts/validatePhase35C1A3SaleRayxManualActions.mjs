#!/usr/bin/env node
/**
 * Fase 3.5C.1.A3 — Modal Raio-X: WhatsApp / E-mail manual via Actions Engine
 * node scripts/validatePhase35C1A3SaleRayxManualActions.mjs
 */

import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, "..");
const frontendRoot = resolve(backendRoot, "..", "suse7-frontend");

loadEnv({ path: resolve(backendRoot, ".env.local") });
loadEnv();

const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function read(rel, root = backendRoot) {
  return readFileSync(resolve(root, rel), "utf8");
}

function fileExists(rel, root = backendRoot) {
  try {
    read(rel, root);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== Fase 3.5C.1.A3 — Raio-X manual WhatsApp / E-mail ===\n");

  const backendFiles = [
    "src/handlers/notifications/saleRayxManualNotificationApi.js",
    "src/domain/notifications/central/sales/triggerManualSaleRayxNotification.js",
    "src/domain/sales/loadSaleOrderItemForSeller.js",
    "src/domain/sales/saleRayxNotificationPayload.js",
    "supabase/migrations/20260523120000_s7_sale_rayx_manual_notification_templates.sql",
  ];
  for (const f of backendFiles) {
    record(`backend_file_${f.split("/").pop()}`, fileExists(f), f);
  }

  const apiIndex = read("api/index.js");
  record(
    "route_post_sale_rayx_manual",
    apiIndex.includes('"/api/notifications/manual/sale-rayx"') &&
      apiIndex.includes("saleRayxManualNotificationApi"),
    ""
  );

  const handlerSrc = read("src/handlers/notifications/saleRayxManualNotificationApi.js");
  record("handler_requires_auth", handlerSrc.includes("requireAuthUser"), "");
  record("handler_validates_channel", handlerSrc.includes('channel !== "whatsapp"'), "");
  record("handler_calls_trigger", handlerSrc.includes("triggerManualSaleRayxNotification"), "");

  const triggerSrc = read("src/domain/notifications/central/sales/triggerManualSaleRayxNotification.js");
  record(
    "trigger_uses_publish_engine",
    triggerSrc.includes("publishNotificationEvent") &&
      triggerSrc.includes("dispatch_options") &&
      triggerSrc.includes("manual_recipients_by_channel"),
    ""
  );
  record(
    "trigger_loads_sale_with_ownership",
    triggerSrc.includes("loadSaleOrderItemForSeller"),
    ""
  );
  record(
    "trigger_no_direct_outbox_process",
    !triggerSrc.includes("processWhatsAppOutbox") && !triggerSrc.includes("processEmailOutbox"),
    ""
  );
  record("trigger_idempotency_window", triggerSrc.includes("manual.sale-rayx:"), "");
  record(
    "trigger_returns_status_fields",
    triggerSrc.includes("queued") && triggerSrc.includes("mocked") && triggerSrc.includes("real_send_executed"),
    ""
  );

  const loaderSrc = read("src/domain/sales/loadSaleOrderItemForSeller.js");
  record("loader_filters_user_id", loaderSrc.includes('.eq("user_id", sellerId)'), "");

  const payloadSrc = read("src/domain/sales/saleRayxNotificationPayload.js");
  record("payload_has_rayx_fields", payloadSrc.includes("sale_rayx_url") && payloadSrc.includes("sale_health"), "");

  const engineSrc = read("src/domain/notifications/central/actions/notificationActionsEngine.js");
  record("engine_manual_recipients", engineSrc.includes("manual_recipients_by_channel"), "");
  record("engine_channels_filter", engineSrc.includes("channels_filter"), "");

  const eventTypes = read("src/domain/notifications/central/constants/eventTypes.js");
  record("catalog_manual_sale_rayx", eventTypes.includes("MANUAL_SALE_RAYX"), "");

  const migration = read("supabase/migrations/20260523120000_s7_sale_rayx_manual_notification_templates.sql");
  record("migration_whatsapp_template", migration.includes("Raio-X da venda"), "");
  record("migration_email_template", migration.includes("'email'"), "");
  record(
    "migration_uses_severity_default",
    migration.includes("severity_default") && !migration.includes("default_severity"),
    ""
  );
  record("migration_has_supported_channels", migration.includes("supported_channels"), "");
  record("migration_precheck_documented", migration.includes("information_schema.columns"), "");

  const feApi = read("src/services/saleRayxManualNotifyApi.js", frontendRoot);
  record("frontend_api_helper", feApi.includes("/api/notifications/manual/sale-rayx"), "", frontendRoot);
  record("frontend_uses_api_fetch", feApi.includes("apiFetch"), "", frontendRoot);

  const feOps = read("src/components/sales/SaleRayXOperationalActions.jsx", frontendRoot);
  record(
    "frontend_no_zapi_direct",
    !feOps.includes("zapi") && !feOps.includes("openWhatsAppShare") && !feOps.includes("openEmailShare"),
    ""
  );
  record("frontend_post_manual_notify", feOps.includes("postSaleRayxManualNotification"), "");
  record("frontend_loading_state", feOps.includes("loadingKey") && feOps.includes("disabled={isLoading}"), "");
  record("frontend_whatsapp_toast", feOps.includes("WhatsApp enfileirado com sucesso"), "");
  record("frontend_email_toast", feOps.includes("E-mail enfileirado com sucesso"), "");
  record("frontend_copy_print_intact", feOps.includes("copySaleRayxSummaryRich") && feOps.includes("printSaleRayx"), "");

  const feModal = read("src/components/sales/SaleDetailModal.jsx", frontendRoot);
  record("modal_passes_sale_id", feModal.includes("saleId={itemId}"), "");

  const outboxSrc = read("src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js");
  record("whatsapp_outbox_provider_agnostic", outboxSrc.includes("sendWhatsAppMessage"), "");

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${passed}/${results.length} PASS ===`);
  if (failed.length) {
    console.error("\nFalhas:");
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
