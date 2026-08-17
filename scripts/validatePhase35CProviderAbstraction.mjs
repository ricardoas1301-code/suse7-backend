#!/usr/bin/env node
/**
 * Fase 3.5C — Provider Abstraction Layer
 * node scripts/validatePhase35CProviderAbstraction.mjs
 */

import { config as loadEnv } from "dotenv";
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
  console.log("=== Fase 3.5C — Provider Abstraction ===\n");

  const { S7_DELIVERY_MODE } = await import(
    "../src/domain/notifications/central/providers/abstraction/deliveryMode.js"
  );
  const {
    resolveEffectiveDeliveryPolicy,
    enforceDeliveryModePolicy,
    resolveAppTier,
    isLiveDeliveryExplicitlyAllowed,
    hasWhatsAppLiveCredentials,
  } = await import(
    "../src/domain/notifications/central/providers/abstraction/providerPolicy.js"
  );
  const { resolveProviderAdapter } = await import(
    "../src/domain/notifications/central/providers/abstraction/ProviderResolver.js"
  );
  const { S7_PROVIDER_CHANNEL } = await import(
    "../src/domain/notifications/central/providers/abstraction/providerChannels.js"
  );
  const {
    sendS7WhatsApp,
    isRealWhatsAppProviderConfigured,
    isWhatsAppLiveDeliveryActive,
  } = await import("../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js");

  const prevMode = process.env.S7_WHATSAPP_MODE;
  const prevAllow = process.env.S7_ALLOW_LIVE_DELIVERY;
  const prevApp = process.env.S7_APP_ENV;

  try {
    process.env.S7_WHATSAPP_MODE = "mock";
    delete process.env.S7_ALLOW_LIVE_DELIVERY;
    process.env.S7_APP_ENV = "development";

    const policyMock = resolveEffectiveDeliveryPolicy(S7_PROVIDER_CHANNEL.WHATSAPP);
    record("dev_default_mock_mode", policyMock.deliveryMode === S7_DELIVERY_MODE.MOCK, policyMock.deliveryMode);

    const resolved = resolveProviderAdapter(S7_PROVIDER_CHANNEL.WHATSAPP);
    record("resolver_returns_adapter", Boolean(resolved.adapter?.send), resolved.adapter?.providerName ?? "");

    const caps = resolved.adapter.getCapabilities();
    record(
      "adapter_capabilities_contract",
      typeof caps.supports_retry === "boolean" && typeof caps.supports_template === "boolean",
      JSON.stringify(caps)
    );

    const health = await resolved.adapter.health();
    record("adapter_health_callable", typeof health.ok === "boolean", String(health.ok));

    const sendMock = await sendS7WhatsApp({ to: "5511999999999", message: "3.5C mock probe" });
    record(
      "send_mock_simulated",
      sendMock.ok && sendMock.simulated === true,
      sendMock.providerMessageId ?? sendMock.error ?? ""
    );
    record(
      "mock_provider_message_id_prefix",
      String(sendMock.providerMessageId ?? "").startsWith("s7_whatsapp_mock"),
      sendMock.providerMessageId ?? ""
    );

    process.env.S7_WHATSAPP_MODE = "dev_sandbox";
    const policySandbox = resolveEffectiveDeliveryPolicy(S7_PROVIDER_CHANNEL.WHATSAPP);
    record(
      "sandbox_mode_resolves",
      policySandbox.deliveryMode === S7_DELIVERY_MODE.SANDBOX,
      policySandbox.deliveryMode
    );

    const blocked = await sendS7WhatsApp({ to: "5511000000001", message: "block test" });
    record("sandbox_whitelist_blocks", blocked.blocked === true, blocked.error ?? "");

    process.env.S7_WHATSAPP_MODE = "live";
    process.env.S7_ALLOW_LIVE_DELIVERY = "false";
    const liveBlocked = enforceDeliveryModePolicy(S7_DELIVERY_MODE.LIVE);
    record(
      "live_blocked_without_flag_in_dev",
      !liveBlocked.allowed || liveBlocked.effectiveMode !== S7_DELIVERY_MODE.LIVE,
      `${liveBlocked.effectiveMode}:${liveBlocked.reason ?? ""}`
    );
    record("live_not_active_in_dev", !isWhatsAppLiveDeliveryActive(), "");

    process.env.S7_WHATSAPP_MODE = "mock";
    record("no_accidental_live_default", !isWhatsAppLiveDeliveryActive(), `tier=${resolveAppTier()}`);

    const { MetaWhatsAppAdapter } = await import(
      "../src/domain/notifications/central/providers/whatsapp/adapters/MetaWhatsAppAdapter.js"
    );
    const { ZapiWhatsAppAdapter } = await import(
      "../src/domain/notifications/central/providers/whatsapp/adapters/ZapiWhatsAppAdapter.js"
    );
    const meta = new MetaWhatsAppAdapter();
    const zapi = new ZapiWhatsAppAdapter();
    record("live_stubs_meta_zapi", meta.providerName === "meta" && zapi.providerName === "zapi", "");

    if (hasWhatsAppLiveCredentials()) {
      process.env.S7_WHATSAPP_MODE = "live";
      process.env.S7_ALLOW_LIVE_DELIVERY = "true";
      const liveAdapter = resolveProviderAdapter(S7_PROVIDER_CHANNEL.WHATSAPP);
      const liveSend = await liveAdapter.adapter.send({
        to: "5511999999999",
        message: "live stub",
      });
      record(
        "live_adapter_not_ready_without_http",
        !liveSend.ok && liveSend.error_code === "PROVIDER_NOT_READY",
        liveSend.error_code ?? ""
      );
    } else {
      record("live_credentials_optional_skip", true, "no live creds in env");
    }

    record(
      "preserves_real_configured_semantics",
      typeof isRealWhatsAppProviderConfigured() === "boolean",
      String(isRealWhatsAppProviderConfigured())
    );
    record("explicit_allow_flag_readable", typeof isLiveDeliveryExplicitlyAllowed() === "boolean", "");
  } finally {
    if (prevMode !== undefined) process.env.S7_WHATSAPP_MODE = prevMode;
    else delete process.env.S7_WHATSAPP_MODE;
    if (prevAllow !== undefined) process.env.S7_ALLOW_LIVE_DELIVERY = prevAllow;
    else delete process.env.S7_ALLOW_LIVE_DELIVERY;
    if (prevApp !== undefined) process.env.S7_APP_ENV = prevApp;
    else delete process.env.S7_APP_ENV;
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
