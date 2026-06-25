#!/usr/bin/env node
/**
 * Valida política de destino Raio-X manual (sem override smoke automático).
 */
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(root, ".env.local") });

process.env.S7_PROVIDER_SMOKE_ENABLED = "false";
process.env.S7_PROVIDER_SMOKE_PHONE = "";
process.env.S7_WHATSAPP_SANDBOX_WHITELIST = "";
process.env.S7_WHATSAPP_MODE = "live";
process.env.S7_ALLOW_LIVE_DELIVERY = "true";
process.env.WHATSAPP_PROVIDER = "zapi";

const {
  resolveControlledSmokePhoneForSeller,
  resolveExplicitSmokePhoneForSeller,
  canProcessManualSaleRayxWhatsAppLive,
  evaluateManualRayxLiveDestinationGuard,
  evaluateManualRayxLiveSendPolicy,
  resolveWhatsAppProcessorSendPolicy,
  resolveZapiProviderSmokeGate,
  buildManualRayxOutboxPolicyMetadata,
  MANUAL_RAYX_LIVE_DESTINATION_SOURCE,
} = await import("../src/domain/notifications/central/sales/manualSaleRayxLiveDelivery.js");
const { dedupeManualRayxRecipientTargets, normalizeBrazilWhatsAppPhone } = await import(
  "../src/domain/notifications/central/sales/manualSaleRayxRecipientTargets.js"
);

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
  } else {
    console.log("PASS:", name);
  }
}

assert("no_auto_smoke_override", resolveControlledSmokePhoneForSeller("any") === null);

process.env.S7_PROVIDER_SMOKE_ENABLED = "true";
process.env.S7_PROVIDER_SMOKE_SELLER = "seller-a";
process.env.S7_PROVIDER_SMOKE_PHONE = "5517991883100";
assert(
  "explicit_smoke_phone",
  resolveExplicitSmokePhoneForSeller("seller-a") === "5517991883100"
);

process.env.S7_PROVIDER_SMOKE_ENABLED = "false";
process.env.S7_PROVIDER_SMOKE_PHONE = "";
process.env.S7_PROVIDER_SMOKE_SELLER = "";

const guardBlock = evaluateManualRayxLiveDestinationGuard({
  normalizedDestinationPhone: "",
  liveDestinationSource: MANUAL_RAYX_LIVE_DESTINATION_SOURCE.UNRESOLVED,
});
assert("blocks_empty_phone", guardBlock.ok === false && guardBlock.reason === "RECIPIENT_PHONE_REQUIRED");

process.env.S7_WHATSAPP_SANDBOX_WHITELIST = "5517991883100";

const bypassPolicy = evaluateManualRayxLiveSendPolicy({
  destinationPhone: "16992326894",
  smokeOverrideApplied: false,
  liveDestinationSource: MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_BODY,
});
assert(
  "live_explicit_bypasses_whitelist",
  bypassPolicy.allowed === true &&
    bypassPolicy.whitelist_bypass_reason === "LIVE_EXPLICIT_ALLOWED" &&
    bypassPolicy.sandbox_whitelist_applied === false
);

const liveNoSmoke = canProcessManualSaleRayxWhatsAppLive({
  sellerId: "seller-b",
  destinationPhone: "16992326894",
  liveDestinationSource: MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_BODY,
  smokeOverrideApplied: false,
});
assert(
  "live_without_smoke_enabled",
  liveNoSmoke.process === true && liveNoSmoke.whitelist_bypass_reason === "LIVE_EXPLICIT_ALLOWED"
);

const outboxMeta = buildManualRayxOutboxPolicyMetadata({
  originalRecipientPhone: "16992326894",
  normalizedDestinationPhone: "16992326894",
  smokeEnabled: true,
  smokeOverrideApplied: false,
  liveDestinationSource: MANUAL_RAYX_LIVE_DESTINATION_SOURCE.RECIPIENT_BODY,
  livePolicyApplied: true,
  sandboxWhitelistApplied: false,
  whitelistBypassReason: "LIVE_EXPLICIT_ALLOWED",
});

const processorPolicy = resolveWhatsAppProcessorSendPolicy({
  to: "16992326894",
  metadata: outboxMeta,
});
assert(
  "processor_respects_outbox_live_bypass",
  processorPolicy.allowed === true &&
    processorPolicy.processor_live_bypass_respected === true &&
    processorPolicy.processor_whitelist_applied === false &&
    processorPolicy.final_send_allowed === true
);

const zapiGate = resolveZapiProviderSmokeGate({
  sellerId: "seller-b",
  phone: "16992326894",
  metadata: outboxMeta,
});
assert(
  "zapi_provider_respects_live_bypass",
  zapiGate.allowed === true &&
    zapiGate.provider_live_bypass_respected === true &&
    zapiGate.provider_smoke_policy_applied === false &&
    zapiGate.provider_final_send_allowed === true
);

assert(
  "normalize_br_11_digits",
  normalizeBrazilWhatsAppPhone("16992326894") === "5516992326894"
);

const dedupe = dedupeManualRayxRecipientTargets(
  [
    { recipientId: "larissa-id", recipientPhone: "5511999990001" },
    { recipientId: "ricardo-id-a", recipientPhone: "16992326894" },
    { recipientId: "ricardo-id-b", recipientPhone: "5516992326894" },
  ],
  { saleId: "sale-1", channel: "whatsapp", useSmokeDestination: false }
);
assert(
  "dedupe_same_br_phone",
  dedupe.final_recipient_targets.length === 2 &&
    dedupe.duplicate_recipients_removed.length === 1 &&
    dedupe.dispatches_planned === 2
);

process.exit(failed ? 1 : 0);
