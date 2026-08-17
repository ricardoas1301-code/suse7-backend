#!/usr/bin/env node
/**
 * Fase 3.5C.1.A1 — Garantia multi-provider WhatsApp
 * node scripts/validatePhase35C1A1MultiProviderWhatsApp.mjs
 */

import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Fase 3.5C.1.A1 — Multi-Provider WhatsApp ===\n");

  const {
    resolveWhatsAppProviderName,
    normalizeWhatsAppProviderName,
    WHATSAPP_PROVIDER_NAMES,
  } = await import(
    "../src/domain/notifications/central/providers/whatsapp/whatsappProviderEnv.js"
  );
  const { ZapiWhatsAppProvider } = await import(
    "../src/domain/notifications/central/providers/whatsapp/ZapiWhatsAppProvider.js"
  );
  const { MetaCloudWhatsAppProvider } = await import(
    "../src/domain/notifications/central/providers/whatsapp/MetaCloudWhatsAppProvider.js"
  );
  const { WhatsAppProviderStrategy } = await import(
    "../src/domain/notifications/central/providers/whatsapp/WhatsAppProviderStrategy.js"
  );
  const {
    resolveWhatsAppProviderAdapter,
    resolveActiveWhatsAppProviderName,
  } = await import(
    "../src/domain/notifications/central/providers/whatsapp/whatsappProviderResolver.js"
  );
  const { sendWhatsAppMessage } = await import(
    "../src/domain/notifications/central/whatsapp/sendWhatsAppMessage.js"
  );
  const { sendS7WhatsApp } = await import(
    "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js"
  );
  const { S7_PROVIDER_CHANNEL } = await import(
    "../src/domain/notifications/central/providers/abstraction/providerChannels.js"
  );
  const { resolveProviderAdapter } = await import(
    "../src/domain/notifications/central/providers/abstraction/ProviderResolver.js"
  );

  const prevWp = process.env.WHATSAPP_PROVIDER;
  const prevS7 = process.env.S7_WHATSAPP_PROVIDER;
  const prevMode = process.env.S7_WHATSAPP_MODE;

  try {
    process.env.S7_WHATSAPP_MODE = "mock";
    delete process.env.S7_ALLOW_LIVE_DELIVERY;

    process.env.WHATSAPP_PROVIDER = "zapi";
    process.env.S7_WHATSAPP_PROVIDER = "meta";
    record(
      "whatsapp_provider_env_precedence",
      resolveWhatsAppProviderName() === WHATSAPP_PROVIDER_NAMES.ZAPI,
      resolveWhatsAppProviderName()
    );

    delete process.env.WHATSAPP_PROVIDER;
    process.env.S7_WHATSAPP_PROVIDER = "meta_cloud";
    record(
      "s7_whatsapp_provider_fallback",
      resolveWhatsAppProviderName() === WHATSAPP_PROVIDER_NAMES.META_CLOUD,
      resolveWhatsAppProviderName()
    );

    record(
      "normalize_meta_cloud_aliases",
      normalizeWhatsAppProviderName("meta-cloud") === WHATSAPP_PROVIDER_NAMES.META_CLOUD,
      ""
    );

    const zapi = new ZapiWhatsAppProvider();
    const metaCloud = new MetaCloudWhatsAppProvider();
    record("zapi_provider_name", zapi.providerName === WHATSAPP_PROVIDER_NAMES.ZAPI, zapi.providerName);
    record(
      "meta_cloud_provider_name",
      metaCloud.providerName === WHATSAPP_PROVIDER_NAMES.META_CLOUD,
      metaCloud.providerName
    );
    record(
      "strategy_contract",
      zapi instanceof WhatsAppProviderStrategy && typeof zapi.send === "function",
      ""
    );

    const resolved = resolveProviderAdapter(S7_PROVIDER_CHANNEL.WHATSAPP);
    record(
      "resolver_mock_default",
      resolved.adapter?.providerName === "mock",
      resolved.adapter?.providerName ?? ""
    );

    const { configured_provider } = resolveWhatsAppProviderAdapter();
    record("resolver_exposes_configured_provider", typeof configured_provider === "string", configured_provider);

    record(
      "active_provider_name_api",
      typeof resolveActiveWhatsAppProviderName() === "string",
      resolveActiveWhatsAppProviderName()
    );

    const mockSend = await sendWhatsAppMessage({ to: "5511999999999", message: "3.5C.1.A1 probe" });
    record(
      "send_whatsapp_message_api",
      mockSend.ok && mockSend.simulated === true,
      mockSend.providerMessageId ?? mockSend.error ?? ""
    );

    const legacySend = await sendS7WhatsApp({ to: "5511999999999", message: "legacy alias" });
    record(
      "send_s7_alias_compatible",
      legacySend.ok && legacySend.simulated === true,
      ""
    );

    const outboxSrc = readFileSync(
      resolve(root, "src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js"),
      "utf8"
    );
    record(
      "outbox_uses_send_whatsapp_message",
      outboxSrc.includes("sendWhatsAppMessage") && !outboxSrc.includes("sendS7WhatsApp("),
      ""
    );

    const zapiClientSrc = readFileSync(
      resolve(root, "src/domain/notifications/central/providers/whatsapp/zapiHttpClient.js"),
      "utf8"
    );
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    function walk(dir, acc = []) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (name.endsWith(".js")) acc.push(p);
      }
      return acc;
    }
    const srcRoot = resolve(root, "src");
    const zapiLeaks = walk(srcRoot).filter((p) => {
      if (p.includes("zapiHttpClient.js") || /ZapiWhatsApp/i.test(p)) return false;
      return readFileSync(p, "utf8").includes("zapiHttpClient");
    });
    record("zapi_http_only_via_adapter", zapiLeaks.length === 0, zapiLeaks[0] ?? "isolated");
    record("zapi_client_no_secrets_in_source", !zapiClientSrc.includes("api.z-api.io/instances/"), "");
  } finally {
    if (prevWp !== undefined) process.env.WHATSAPP_PROVIDER = prevWp;
    else delete process.env.WHATSAPP_PROVIDER;
    if (prevS7 !== undefined) process.env.S7_WHATSAPP_PROVIDER = prevS7;
    if (prevMode !== undefined) process.env.S7_WHATSAPP_MODE = prevMode;
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
