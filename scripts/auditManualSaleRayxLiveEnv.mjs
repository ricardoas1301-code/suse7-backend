#!/usr/bin/env node
/**
 * Auditoria env + política live — Modal Raio-X WhatsApp manual
 * node scripts/auditManualSaleRayxLiveEnv.mjs [seller_id] [phone_digits]
 */

import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  auditManualSaleRayxWhatsAppLive,
  getManualSaleRayxRuntimeEnvSnapshot,
} from "../src/domain/notifications/central/sales/manualSaleRayxLiveDelivery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const sellerId =
  process.argv[2]?.trim() ||
  process.env.S7_PROVIDER_SMOKE_SELLER?.trim() ||
  "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const phone = String(process.argv[3] ?? process.env.S7_PROVIDER_SMOKE_PHONE ?? "5517991883100").replace(
  /\D/g,
  ""
);

console.log("=== Auditoria live — Raio-X manual WhatsApp ===\n");
console.log("Arquivos dotenv: .env.local (prioridade) + .env\n");

const env = getManualSaleRayxRuntimeEnvSnapshot();
console.log("--- Runtime env (processo atual) ---");
console.log(JSON.stringify(env, null, 2));

const audit = auditManualSaleRayxWhatsAppLive({ sellerId, destinationPhone: phone });
console.log("\n--- Política (seller + telefone) ---");
console.log(JSON.stringify(audit, null, 2));

console.log("\n--- Diagnóstico ---");
if (env.s7_whatsapp_mode !== "live") {
  console.log("BLOQUEIO: S7_WHATSAPP_MODE não é 'live' → live_process_reason esperado: LIVE_DELIVERY_OFF");
}
if (env.s7_allow_live_delivery !== "true") {
  console.log("BLOQUEIO: S7_ALLOW_LIVE_DELIVERY não é 'true'");
}
if (env.s7_provider_smoke_enabled !== "true") {
  console.log("BLOQUEIO: S7_PROVIDER_SMOKE_ENABLED não é 'true' → SMOKE_POLICY_REQUIRED_FOR_MANUAL_LIVE");
}
if (audit.smoke_policy?.allowed === false) {
  console.log(`BLOQUEIO smoke: ${audit.smoke_policy.reason ?? "seller/telefone não batem com smoke"}`);
}
if (audit.will_process_outbox) {
  console.log("OK: com este processo, processWhatsAppOutboxDispatch SERIA chamado na rota manual.");
} else {
  console.log(`SKIP outbox live: ${audit.live_process_reason}`);
}
console.log("\nReinicie o backend (npm run dev) após alterar .env.local — o servidor lê env só no boot.");
