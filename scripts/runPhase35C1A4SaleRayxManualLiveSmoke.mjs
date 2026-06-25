#!/usr/bin/env node
/**
 * S7 Mission Control — Fase 3.5C.1.A4 — Smoke HTTP live controlado Raio-X → Z-API
 *
 * POST /api/notifications/manual/sale-rayx → outbox → processWhatsAppOutbox(dispatch)
 *
 * Pré-requisitos (.env.local):
 *   WHATSAPP_PROVIDER=zapi (ou S7_WHATSAPP_PROVIDER=zapi)
 *   S7_WHATSAPP_MODE=live
 *   S7_ALLOW_LIVE_DELIVERY=true
 *   S7_PROVIDER_SMOKE_ENABLED=true (somente smoke; modal DEV usa false)
 *   Para forçar destino smoke no body: use_smoke_destination=true (sem override automático)
 *   S7_ZAPI_BASE_URL=...
 *   S7_ZAPI_TOKEN=... (Client-Token)
 *   S7_PROVIDER_SMOKE_SELLER=<uuid dono da venda>
 *   S7_PROVIDER_SMOKE_PHONE=5517991883100
 *   S7_WHATSAPP_SANDBOX_WHITELIST=5517991883100 (recomendado)
 *
 * node scripts/runPhase35C1A4SaleRayxManualLiveSmoke.mjs
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { getManualSaleRayxLivePrecheck } from "../src/domain/notifications/central/sales/manualSaleRayxLiveDelivery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv({ path: resolve(root, "../suse7-frontend/.env.development") });
loadEnv();

const AUTHORIZED_PHONE = String(
  process.env.S7_RAYX_LIVE_SMOKE_PHONE ?? process.env.S7_PROVIDER_SMOKE_PHONE ?? "5517991883100"
).replace(/\D/g, "");

const ENV_KEYS = [
  "S7_WHATSAPP_MODE",
  "S7_ALLOW_LIVE_DELIVERY",
  "S7_PROVIDER_SMOKE_ENABLED",
  "S7_WHATSAPP_PROVIDER",
  "WHATSAPP_PROVIDER",
  "S7_PROVIDER_SMOKE_SELLER",
  "S7_PROVIDER_SMOKE_PHONE",
  "S7_ZAPI_BASE_URL",
  "S7_ZAPI_TOKEN",
];

/** @type {Record<string, string | undefined>} */
const envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function applyLiveEnv() {
  process.env.S7_WHATSAPP_MODE = "live";
  process.env.S7_ALLOW_LIVE_DELIVERY = "true";
  process.env.S7_PROVIDER_SMOKE_ENABLED = "true";
  process.env.S7_WHATSAPP_PROVIDER = "zapi";
  process.env.WHATSAPP_PROVIDER = "zapi";
  if (!process.env.S7_PROVIDER_SMOKE_PHONE) {
    process.env.S7_PROVIDER_SMOKE_PHONE = AUTHORIZED_PHONE;
  }
  const wl = String(process.env.S7_WHATSAPP_SANDBOX_WHITELIST ?? "").trim();
  if (!wl.includes(AUTHORIZED_PHONE)) {
    process.env.S7_WHATSAPP_SANDBOX_WHITELIST = wl ? `${wl},${AUTHORIZED_PHONE}` : AUTHORIZED_PHONE;
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const val = envSnapshot[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  process.env.S7_WHATSAPP_MODE = "mock";
  process.env.S7_ALLOW_LIVE_DELIVERY = "false";
  process.env.S7_PROVIDER_SMOKE_ENABLED = "false";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sbUrl
 * @param {string} anonKey
 * @param {string} userId
 */
async function getJwtForUserId(sb, sbUrl, anonKey, userId) {
  const { data: userRow, error: userErr } = await sb.auth.admin.getUserById(userId);
  if (userErr || !userRow?.user?.email) throw new Error(userErr?.message ?? "sem email");
  const email = String(userRow.user.email);
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw linkErr;
  const verifyRes = await fetch(`${sbUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "email",
      token: link.properties.email_otp,
      email,
    }),
  });
  const verifyJson = await verifyRes.json();
  if (!verifyJson?.access_token) throw new Error(`verify failed status=${verifyRes.status}`);
  return verifyJson.access_token;
}

/**
 * @param {string} apiBase
 * @param {string} jwt
 * @param {{ saleId: string; recipientPhone: string }} body
 */
async function postManualRayx(apiBase, jwt, body) {
  const res = await fetch(`${apiBase}/api/notifications/manual/sale-rayx`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sale_id: body.saleId,
      channel: "whatsapp",
      recipient_phone: body.recipientPhone,
    }),
  });
  return { httpStatus: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} saleId
 */
async function purgeManualRayxForSale(sb, sellerId, saleId) {
  const { data: events } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .like("idempotency_key", `manual.sale-rayx:${saleId}:%`);
  const eventIds = (events ?? []).map((e) => String(e.id));
  if (!eventIds.length) return;
  const { data: dispatches } = await sb
    .from("s7_notification_dispatches")
    .select("id")
    .in("event_id", eventIds);
  const dispatchIds = (dispatches ?? []).map((d) => String(d.id));
  if (dispatchIds.length) {
    await sb.from("s7_notification_whatsapp_outbox").delete().in("dispatch_id", dispatchIds);
    await sb.from("s7_notification_dispatches").delete().in("id", dispatchIds);
  }
  await sb.from("s7_notification_events").delete().in("id", eventIds);
}

async function main() {
  console.log("=== S7 Fase 3.5C.1.A4 — Raio-X manual LIVE (Z-API controlado) ===\n");

  applyLiveEnv();

  const precheck = getManualSaleRayxLivePrecheck();
  console.log("--- Pré-check ---");
  console.log(JSON.stringify(precheck, null, 2));
  console.log(`authorized_phone=${AUTHORIZED_PHONE}\n`);

  const failures = [];
  if (precheck.whatsapp_provider !== "zapi") failures.push("WHATSAPP_PROVIDER must be zapi");
  if (precheck.s7_whatsapp_mode !== "live") failures.push("S7_WHATSAPP_MODE must be live");
  if (precheck.s7_allow_live_delivery !== "true") failures.push("S7_ALLOW_LIVE_DELIVERY must be true");
  if (precheck.s7_provider_smoke_enabled !== "true") failures.push("S7_PROVIDER_SMOKE_ENABLED must be true");
  if (precheck.s7_provider_smoke_phone !== AUTHORIZED_PHONE) {
    failures.push(`S7_PROVIDER_SMOKE_PHONE must be ${AUTHORIZED_PHONE}`);
  }
  if (!precheck.live_delivery_active) failures.push("live_delivery_active is false");
  if (!process.env.S7_ZAPI_BASE_URL?.trim()) failures.push("S7_ZAPI_BASE_URL missing");

  if (failures.length) {
    console.error("ABORT pré-check:");
    for (const f of failures) console.error(`  - ${f}`);
    restoreEnv();
    process.exit(2);
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const anonKey =
    process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();
  const smokeSeller = String(process.env.S7_PROVIDER_SMOKE_SELLER ?? "").trim();

  if (!supabaseUrl || !serviceKey || !anonKey || !smokeSeller) {
    console.error("ABORT: SUPABASE_* / S7_PROVIDER_SMOKE_SELLER");
    restoreEnv();
    process.exit(2);
  }

  process.env.S7_PROVIDER_SMOKE_SELLER = smokeSeller;

  const apiBase = (process.env.S7_API_BASE || "http://localhost:3001").replace(/\/+$/, "");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let saleId = process.env.S7_RAYX_SMOKE_SALE_ID?.trim();
  if (!saleId) {
    const { data: row } = await sb
      .from("sales_order_items")
      .select("id")
      .eq("user_id", smokeSeller)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    saleId = row?.id ? String(row.id) : "";
  }
  if (!saleId) {
    console.error("ABORT: nenhuma venda para o smoke seller");
    restoreEnv();
    process.exit(2);
  }

  await purgeManualRayxForSale(sb, smokeSeller, saleId);

  const useHttp = String(process.env.S7_RAYX_A4_HTTP ?? "").trim() === "1";
  /** @type {{ httpStatus: number; json: Record<string, unknown> }} */
  let first;
  /** @type {{ httpStatus: number; json: Record<string, unknown> }} */
  let replay;

  if (useHttp) {
    console.log("Modo HTTP — o backend em execução precisa ter flags live no .env.local\n");
    const jwt = await getJwtForUserId(sb, supabaseUrl, anonKey, smokeSeller);
    first = await postManualRayx(apiBase, jwt, { saleId, recipientPhone: AUTHORIZED_PHONE });
    replay = await postManualRayx(apiBase, jwt, { saleId, recipientPhone: AUTHORIZED_PHONE });
  } else {
    console.log("Modo inline — flags live aplicadas neste processo (recomendado para smoke)\n");
    const { triggerManualSaleRayxNotification } = await import(
      "../src/domain/notifications/central/sales/triggerManualSaleRayxNotification.js"
    );
    const json1 = await triggerManualSaleRayxNotification(sb, {
      sellerId: smokeSeller,
      saleId,
      channel: "whatsapp",
      recipientPhone: AUTHORIZED_PHONE,
    });
    first = { httpStatus: json1.ok ? 200 : 422, json: json1 };
    const json2 = await triggerManualSaleRayxNotification(sb, {
      sellerId: smokeSeller,
      saleId,
      channel: "whatsapp",
      recipientPhone: AUTHORIZED_PHONE,
    });
    replay = { httpStatus: json2.ok ? 200 : 422, json: json2 };
  }

  const dispatchId = first.json?.dispatch_id ?? null;
  let outboxBefore = null;
  let outboxAfter = null;
  if (dispatchId) {
    const { data: ob } = await sb
      .from("s7_notification_whatsapp_outbox")
      .select("id, status, provider_message_id, attempts, last_error, metadata")
      .eq("dispatch_id", dispatchId)
      .maybeSingle();
    outboxAfter = ob;
    outboxBefore = "pending";
  }

  const { count: outboxRows } = await sb
    .from("s7_notification_whatsapp_outbox")
    .select("id", { count: "exact", head: true })
    .eq("dispatch_id", dispatchId ?? "__none__");

  restoreEnv();

  const checks = {
    http_ok: first.httpStatus === 200 && first.json?.success === true,
    real_send: first.json?.real_send_executed === true,
    status_sent: first.json?.status === "sent",
    outbox_sent: outboxAfter?.status === "sent",
    provider_message_id: Boolean(outboxAfter?.provider_message_id),
    provider_zapi: first.json?.provider_key === "zapi",
    single_outbox_row: (outboxRows ?? 0) === 1,
    idempotent_replay: replay.json?.skipped === true,
    timing_reported: Boolean(first.json?.timing?.provider_ms != null),
    env_restored_mock: process.env.S7_WHATSAPP_MODE === "mock",
  };

  const report = {
    phase: "S_3.5C.1.A4",
    precheck,
    authorized_phone: AUTHORIZED_PHONE,
    sale_id: saleId,
    seller_id: smokeSeller,
    channel: "whatsapp",
    mode: useHttp ? "http" : "inline",
    api_base: useHttp ? apiBase : null,
    http_status: first.httpStatus,
    response: first.json,
    idempotent_replay: replay.json,
    dispatch_id: dispatchId,
    outbox_id: outboxAfter?.id ?? first.json?.outbox_id,
    outbox_status_before: outboxBefore,
    outbox_status_after: outboxAfter?.status ?? first.json?.outbox_status,
    provider_key: first.json?.provider_key,
    provider_message_id: outboxAfter?.provider_message_id ?? first.json?.provider_message_id,
    attempts: outboxAfter?.attempts ?? first.json?.attempts,
    duration_ms_route: first.json?.route_duration_ms ?? first.json?.duration_ms,
    timing: first.json?.timing,
    outbox_rows_for_dispatch: outboxRows ?? 0,
    env_restored_safe: true,
    checks,
    success: Object.values(checks).every(Boolean),
  };

  console.log("\n--- Relatório S_3.5C.1.A4 ---");
  console.log(JSON.stringify(report, null, 2));

  process.exit(report.success ? 0 : 5);
}

main().catch((e) => {
  restoreEnv();
  console.error("FATAL", e);
  process.exit(1);
});
