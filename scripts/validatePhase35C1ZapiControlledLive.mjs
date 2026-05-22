#!/usr/bin/env node
/**
 * Fase 3.5C.1 — Z-API Controlled Live Integration
 * node scripts/validatePhase35C1ZapiControlledLive.mjs
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
  console.log("=== Fase 3.5C.1 — Z-API Controlled Live ===\n");

  const saved = {
    mode: process.env.S7_WHATSAPP_MODE,
    allow: process.env.S7_ALLOW_LIVE_DELIVERY,
    app: process.env.S7_APP_ENV,
    provider: process.env.S7_WHATSAPP_PROVIDER,
    smoke: process.env.S7_PROVIDER_SMOKE_ENABLED,
    smokeSeller: process.env.S7_PROVIDER_SMOKE_SELLER,
    smokePhone: process.env.S7_PROVIDER_SMOKE_PHONE,
    baseUrl: process.env.S7_ZAPI_BASE_URL,
  };

  try {
    const { assertWhatsAppLiveDeliveryEnabled, isWhatsAppLiveDeliveryEnabled } = await import(
      "../src/domain/notifications/central/providers/abstraction/providerLiveDeliveryGate.js"
    );
    const { evaluateProviderSmokePolicy } = await import(
      "../src/domain/notifications/central/providers/abstraction/providerSmokePolicy.js"
    );
    const { buildProviderHealthResult } = await import(
      "../src/domain/notifications/central/providers/abstraction/providerHealthResult.js"
    );
    const { ZapiWhatsAppAdapter } = await import(
      "../src/domain/notifications/central/providers/whatsapp/adapters/ZapiWhatsAppAdapter.js"
    );
    const { mapZapiHttpError } = await import(
      "../src/domain/notifications/central/providers/whatsapp/zapiHttpClient.js"
    );
    const { maskPhoneForProviderLog } = await import(
      "../src/domain/notifications/central/providers/abstraction/providerObservability.js"
    );

    process.env.S7_APP_ENV = "development";
    process.env.S7_WHATSAPP_MODE = "mock";
    process.env.S7_ALLOW_LIVE_DELIVERY = "false";
    let gate = assertWhatsAppLiveDeliveryEnabled();
    record("live_disabled_without_flag", !gate.ok && gate.error === "LIVE_DELIVERY_DISABLED", gate.error ?? "");

    process.env.S7_WHATSAPP_MODE = "live";
    process.env.S7_ALLOW_LIVE_DELIVERY = "false";
    gate = assertWhatsAppLiveDeliveryEnabled();
    record(
      "live_disabled_flag_off",
      !gate.ok && gate.error === "LIVE_DELIVERY_DISABLED",
      gate.error ?? ""
    );

    process.env.S7_ALLOW_LIVE_DELIVERY = "true";
    gate = assertWhatsAppLiveDeliveryEnabled();
    record("live_enabled_when_both_set", gate.ok, String(gate.ok));

    process.env.S7_APP_ENV = "production";
    gate = assertWhatsAppLiveDeliveryEnabled();
    record("prod_live_blocked", !gate.ok && gate.error === "PROD_LIVE_BLOCKED", gate.error ?? "");
    process.env.S7_APP_ENV = "development";

    process.env.S7_PROVIDER_SMOKE_ENABLED = "true";
    process.env.S7_PROVIDER_SMOKE_SELLER = "seller-smoke-001";
    process.env.S7_PROVIDER_SMOKE_PHONE = "5511999999999";
    process.env.S7_WHATSAPP_MODE = "live";
    process.env.S7_ALLOW_LIVE_DELIVERY = "true";

    const smokeBadSeller = evaluateProviderSmokePolicy({
      sellerId: "other-seller",
      phone: "5511999999999",
    });
    record(
      "smoke_blocks_invalid_seller",
      !smokeBadSeller.allowed && smokeBadSeller.reason === "BLOCKED_BY_SMOKE_POLICY",
      smokeBadSeller.reason ?? ""
    );

    const smokeBadPhone = evaluateProviderSmokePolicy({
      sellerId: "seller-smoke-001",
      phone: "5511888000000",
    });
    record(
      "smoke_blocks_invalid_phone",
      !smokeBadPhone.allowed && smokeBadPhone.reason === "BLOCKED_BY_SMOKE_POLICY",
      smokeBadPhone.reason ?? ""
    );

    const smokeOk = evaluateProviderSmokePolicy({
      sellerId: "seller-smoke-001",
      phone: "5511999999999",
    });
    record("smoke_allows_configured_pair", smokeOk.allowed, "");

    const masked = maskPhoneForProviderLog("5511999999999");
    record(
      "phone_mask_tail_visible",
      masked.endsWith("9999") && masked.includes("*") && !masked.includes("5511999999999"),
      masked
    );

    const healthShape = buildProviderHealthResult({
      provider: "zapi",
      ok: true,
      latency_ms: 12,
    });
    record(
      "health_result_contract",
      healthShape.provider === "zapi" &&
        healthShape.status === "ok" &&
        typeof healthShape.timestamp === "string",
      healthShape.status
    );

    record("http_error_mapping_401", mapZapiHttpError(401, {}) === "AUTH_FAILED", "");
    record("http_error_mapping_429", mapZapiHttpError(429, {}) === "RATE_LIMITED", "");
    record("http_error_mapping_503", mapZapiHttpError(503, {}) === "PROVIDER_UNAVAILABLE", "");

    const adapter = new ZapiWhatsAppAdapter();
    delete process.env.S7_ZAPI_BASE_URL;
    const healthNoConfig = await adapter.health();
    record(
      "health_without_zapi_config",
      healthNoConfig.status !== "ok" && healthNoConfig.error_code === "ZAPI_NOT_CONFIGURED",
      healthNoConfig.error_code ?? ""
    );

    const sendBlocked = await adapter.send({
      to: "5511999999999",
      message: "teste",
      metadata: { seller_id: "seller-smoke-001" },
    });
    record(
      "send_blocked_without_base_url",
      !sendBlocked.ok && sendBlocked.error_code === "ZAPI_NOT_CONFIGURED",
      sendBlocked.error_code ?? ""
    );

    process.env.S7_PROVIDER_SMOKE_ENABLED = "false";
    const sendSmokeOff = await adapter.send({
      to: "5511999999999",
      message: "teste",
      metadata: { seller_id: "seller-smoke-001" },
    });
    record(
      "send_blocked_smoke_disabled",
      !sendSmokeOff.ok && sendSmokeOff.error_code === "BLOCKED_BY_SMOKE_POLICY",
      sendSmokeOff.error_code ?? ""
    );

    process.env.S7_PROVIDER_SMOKE_ENABLED = "true";
    process.env.S7_ZAPI_BASE_URL = "https://invalid.zapi.smoke.test/instance/token/smoke";
    const sendUnavailable = await adapter.send({
      to: "5511999999999",
      message: "teste indisponivel",
      metadata: { seller_id: "seller-smoke-001", dispatch_id: "smoke-dispatch-1" },
    });
    record(
      "provider_unavailable_handled",
      !sendUnavailable.ok &&
        ["TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "ZAPI_NOT_CONFIGURED"].includes(
          String(sendUnavailable.error_code ?? "")
        ),
      sendUnavailable.error_code ?? ""
    );

    if (process.env.S7_ZAPI_SMOKE_RUN === "true" && saved.baseUrl) {
      process.env.S7_ZAPI_BASE_URL = saved.baseUrl;
      process.env.S7_WHATSAPP_PROVIDER = "zapi";
      const liveHealth = await adapter.health();
      record("optional_real_health", liveHealth.status === "ok", liveHealth.error_code ?? liveHealth.status);
      if (smokeOk.allowed) {
        const liveSend = await adapter.send({
          to: process.env.S7_PROVIDER_SMOKE_PHONE,
          message: `S7 smoke 3.5C.1 ${new Date().toISOString()}`,
          metadata: {
            seller_id: process.env.S7_PROVIDER_SMOKE_SELLER,
            dispatch_id: `smoke-${Date.now()}`,
          },
        });
        record(
          "optional_real_send_success",
          liveSend.ok === true && liveSend.simulated !== true,
          liveSend.provider_message_id ?? liveSend.error_code ?? ""
        );
      }
    } else {
      record("optional_real_smoke_skipped", true, "set S7_ZAPI_SMOKE_RUN=true + S7_ZAPI_BASE_URL");
    }

    process.env.S7_ALLOW_LIVE_DELIVERY = "false";
    process.env.S7_WHATSAPP_MODE = "mock";
    record(
      "rollback_live_off",
      !isWhatsAppLiveDeliveryEnabled(),
      `enabled=${isWhatsAppLiveDeliveryEnabled()}`
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const key = {
        mode: "S7_WHATSAPP_MODE",
        allow: "S7_ALLOW_LIVE_DELIVERY",
        app: "S7_APP_ENV",
        provider: "S7_WHATSAPP_PROVIDER",
        smoke: "S7_PROVIDER_SMOKE_ENABLED",
        smokeSeller: "S7_PROVIDER_SMOKE_SELLER",
        smokePhone: "S7_PROVIDER_SMOKE_PHONE",
        baseUrl: "S7_ZAPI_BASE_URL",
      }[k];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
