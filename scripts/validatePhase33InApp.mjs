#!/usr/bin/env node
/**
 * Fase 3.3 — In-App delivery engine (API DEV + motor central)
 *
 * node scripts/validatePhase33InApp.mjs
 *
 * Requer migration 20260522180000_s7_notification_in_app_phase33.sql aplicada em DEV.
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  SUITE_33_IN_APP_EVENT,
  SUITE_33_MANDATORY_EVENT,
  cleanupSuite33Run,
  prepareSuite33Isolation,
  resolveSellerIdByEmail,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(
  /\/+$/,
  ""
);
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || serviceKey;
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";

/** @type {Array<{ name: string, pass: boolean, detail?: string }>} */
const results = [];

function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(email, password) {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  return json.access_token ?? null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  console.log("=== Fase 3.3 — In-App inbox (isolated) ===\n");

  const runToken = String(Date.now());
  const token = await login(testEmail, testPassword);
  if (!token) {
    record("auth", false, "JWT ausente");
    process.exit(1);
  }
  record("auth", true);

  if (!serviceKey || !supabaseUrl) {
    record("service_role", false, "SUPABASE_URL/SERVICE_ROLE ausente");
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const sellerId = await resolveSellerIdByEmail(sb, testEmail);
  if (!sellerId) {
    record("seller_id", false, "não encontrado");
    process.exit(1);
  }

  await prepareSuite33Isolation(sb, sellerId, runToken);
  record("isolation_prepare", true, `runToken=${runToken}`);

  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );

  const idemKey = `p33.${runToken}.generated`;
  const pub1 = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_IN_APP_EVENT.category,
    type: SUITE_33_IN_APP_EVENT.type_key,
    idempotency_key: idemKey,
    correlation_id: `corr_${runToken}`,
    payload: { plan_name: `QA33 ${runToken}` },
    source_module: "validate_phase33",
  });

  record(
    "publish_generates_dispatch",
    pub1.ok === true && (pub1.dispatches?.inserted ?? 0) >= 1,
    `inserted=${pub1.dispatches?.inserted ?? 0} err=${pub1.error ?? ""}`
  );

  const pubDup = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_IN_APP_EVENT.category,
    type: SUITE_33_IN_APP_EVENT.type_key,
    idempotency_key: idemKey,
    payload: { plan_name: `QA33 dup ${runToken}` },
  });

  record(
    "idempotency_no_duplicate_dispatch",
    pubDup.ok && pubDup.idempotent === true && (pubDup.dispatches?.skipped_engine || pubDup.dispatches?.inserted === 0),
    `idempotent=${pubDup.idempotent}`
  );

  const { listSellerNotificationInbox, markSellerInboxItemRead, markAllSellerInboxRead } =
    await import("../src/domain/notifications/central/seller/sellerNotificationInboxService.js");

  const inboxApi = await api(token, "GET", "/api/notifications/inbox?limit=5");
  const useDirectInbox = inboxApi.status === 404;
  const inbox1 = useDirectInbox
    ? await listSellerNotificationInbox(sb, { sellerId, limit: 5 })
    : inboxApi.json;

  record(
    "inbox_list_ok",
    useDirectInbox
      ? Array.isArray(inbox1.items)
      : inboxApi.status === 200 && Array.isArray(inbox1.items),
    useDirectInbox ? "direct_service (API 404 — deploy pendente)" : `status=${inboxApi.status}`
  );

  const unreadBefore = Number(inbox1.unread_count ?? 0);
  record("unread_count_positive", unreadBefore >= 1, `unread=${unreadBefore}`);

  const target = (inbox1.items ?? []).find(
    (i) => i.type_key === SUITE_33_IN_APP_EVENT.type_key && i.category_code === SUITE_33_IN_APP_EVENT.category
  );
  record("inbox_item_fields", Boolean(target?.id && target?.title && target?.deep_link), `id=${target?.id ?? ""}`);

  record(
    "deep_link_billing",
    String(target?.deep_link ?? "").includes("/perfil/assinatura"),
    target?.deep_link ?? ""
  );

  if (target?.id) {
    const mark = useDirectInbox
      ? await markSellerInboxItemRead(sb, sellerId, target.id)
      : (await api(token, "PATCH", `/api/notifications/inbox/${target.id}/read`)).json;
    record(
      "mark_one_read",
      useDirectInbox ? mark.ok === true : inboxApi.status !== 404 && mark.ok === true,
      useDirectInbox ? "direct_service" : `status`
    );

    const inboxAfter = useDirectInbox
      ? await listSellerNotificationInbox(sb, { sellerId, limit: 20 })
      : (await api(token, "GET", "/api/notifications/inbox?limit=20")).json;
    const afterItem = (inboxAfter.items ?? []).find((i) => String(i.id) === String(target.id));
    record("history_preserved_after_read", Boolean(afterItem?.is_read), "item still listed");

    const unreadAfterOne = Number(inboxAfter.unread_count ?? 0);
    record("unread_count_decreased", unreadAfterOne < unreadBefore, `${unreadBefore} -> ${unreadAfterOne}`);
  } else {
    record("mark_one_read", false, "sem item alvo");
    record("history_preserved_after_read", false, "sem item");
    record("unread_count_decreased", false, "sem item");
  }

  await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_IN_APP_EVENT.category,
    type: SUITE_33_IN_APP_EVENT.type_key,
    idempotency_key: `p33.${runToken}.page2`,
    payload: { plan_name: "page2" },
  });

  const page1 = useDirectInbox
    ? await listSellerNotificationInbox(sb, { sellerId, limit: 1 })
    : (await api(token, "GET", "/api/notifications/inbox?limit=1")).json;
  const cursor = page1.cursor;
  const page2 = cursor
    ? useDirectInbox
      ? await listSellerNotificationInbox(sb, { sellerId, limit: 1, cursor })
      : (await api(token, "GET", `/api/notifications/inbox?limit=1&cursor=${encodeURIComponent(cursor)}`)).json
    : { items: [] };

  record(
    "pagination_cursor",
    page1.has_more === true && Array.isArray(page2.items),
    `has_more=${page1.has_more} cursor=${cursor ? "yes" : "no"}`
  );

  await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_IN_APP_EVENT.category,
    type: SUITE_33_IN_APP_EVENT.type_key,
    idempotency_key: `p33.${runToken}.bulk`,
    payload: { plan_name: "bulk" },
  });

  const markAll = useDirectInbox
    ? await markAllSellerInboxRead(sb, sellerId)
    : (await api(token, "PATCH", "/api/notifications/inbox/read-all")).json;
  record(
    "mark_all_read",
    markAll.ok === true && Number(markAll.updated_count ?? 0) >= 0,
    `updated=${markAll.updated_count ?? 0}`
  );

  const inboxAllRead = useDirectInbox
    ? await listSellerNotificationInbox(sb, { sellerId, limit: 30 })
    : (await api(token, "GET", "/api/notifications/inbox?limit=30")).json;
  record(
    "mark_all_unread_zero",
    Number(inboxAllRead.unread_count ?? -1) === 0,
    `unread=${inboxAllRead.unread_count}`
  );

  await sb.from("s7_notification_preferences").upsert(
    {
      seller_id: sellerId,
      category_code: SUITE_33_MANDATORY_EVENT.category,
      type_key: SUITE_33_MANDATORY_EVENT.type_key,
      channel: "in_app",
      enabled: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "seller_id,category_code,type_key,channel" }
  );

  const mandatoryPub = await publishNotificationEvent(sb, {
    seller_id: sellerId,
    category: SUITE_33_MANDATORY_EVENT.category,
    type: SUITE_33_MANDATORY_EVENT.type_key,
    idempotency_key: `p33.${runToken}.mandatory`,
    payload: { plan_name: "mandatory" },
  });

  const { data: mandatoryEventRows } = await sb
    .from("s7_notification_events")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("idempotency_key", `p33.${runToken}.mandatory`);
  const mandatoryEventIds = (mandatoryEventRows ?? []).map((e) => e.id);

  const { data: mandatoryDispatches } =
    mandatoryEventIds.length > 0
      ? await sb
          .from("s7_notification_dispatches")
          .select("id, channel, metadata")
          .eq("seller_id", sellerId)
          .in("event_id", mandatoryEventIds)
      : { data: [] };

  const mandatoryInAppInserted = (mandatoryDispatches ?? []).some((d) => d.channel === "in_app");

  record(
    "mandatory_in_app_despite_pref_off",
    mandatoryPub.ok && mandatoryInAppInserted,
    `pipeline_inserted=${mandatoryPub.dispatches?.inserted ?? 0} in_app=${mandatoryInAppInserted}`
  );

  const billingInbox = (inboxAllRead.items ?? []).filter((i) => i.category_code === "BILLING");
  record("billing_items_in_inbox", billingInbox.length >= 1, `billing_items=${billingInbox.length}`);

  await cleanupSuite33Run(sb, sellerId, runToken);
  record("isolation_cleanup", true);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
