#!/usr/bin/env node
/**
 * Fase 3.2.2 — destinatário pessoa + regras por evento (API DEV)
 * Isolamento: regras em PAYMENT_GENERATED (não colide com 3.2.1); cleanup por runToken.
 *
 * node scripts/validatePhase322RecipientUx.mjs
 */

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  SUITE_322_RULES_EVENT,
  cleanupSuite322Run,
  prepareSuite322Isolation,
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
  console.log("=== Fase 3.2.2 — Recipient UX + event rules (isolated) ===\n");

  const runToken = String(Date.now());
  const token = await login(testEmail, testPassword);
  if (!token) {
    record("auth", false, "JWT ausente");
    process.exit(1);
  }
  record("auth", true);

  let sb = null;
  let sellerId = null;
  if (serviceKey && supabaseUrl) {
    sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    sellerId = await resolveSellerIdByEmail(sb, testEmail);
    if (sellerId) {
      await prepareSuite322Isolation(sb, sellerId, runToken);
      record(
        "isolation_prepare",
        true,
        `event rules slot ${SUITE_322_RULES_EVENT.category}:${SUITE_322_RULES_EVENT.type_key}`
      );
    } else {
      record("isolation_prepare", false, "seller_id não encontrado");
    }
  }

  const sharedWa = `5511988${String(runToken).slice(-7)}`;
  const sharedEmail = `p322.shared.${runToken}@suse7.test`;

  const missingFields = await api(token, "POST", "/api/notifications/recipients", {
    label: "",
    email: "",
    whatsapp: "",
  });
  record(
    "block_missing_required_fields",
    missingFields.status === 400,
    `status=${missingFields.status} error=${missingFields.json.error ?? ""}`
  );

  const personA = await api(token, "POST", "/api/notifications/recipients", {
    label: `QA322 A ${runToken}`,
    email: `p322.a.${runToken}@suse7.test`,
    whatsapp: `5511977${String(runToken).slice(-7)}`,
  });
  record(
    "create_person_full_contact",
    personA.status === 201 && personA.json.group?.group_id,
    `status=${personA.status}`
  );

  await api(token, "POST", "/api/notifications/recipients", {
    label: `QA322 Seed Email ${runToken}`,
    email: sharedEmail,
    whatsapp: `5511955${String(runToken).slice(-7)}`,
  });

  const dupeEmail2 = await api(token, "POST", "/api/notifications/recipients", {
    label: `QA322 Dupe Email 2 ${runToken}`,
    email: sharedEmail,
    whatsapp: `5511944${String(runToken).slice(-7)}`,
  });
  record(
    "duplicate_email_message_and_field",
    dupeEmail2.status === 409 &&
      dupeEmail2.json.error === "DUPLICATE_RECIPIENT" &&
      dupeEmail2.json.duplicated_field === "email" &&
      String(dupeEmail2.json.message).includes("E-mail já cadastrado"),
    `status=${dupeEmail2.status} field=${dupeEmail2.json.duplicated_field ?? ""}`
  );

  await api(token, "POST", "/api/notifications/recipients", {
    label: `QA322 Seed WA ${runToken}`,
    email: `p322.wa.${runToken}@suse7.test`,
    whatsapp: sharedWa,
  });

  const dupeWa = await api(token, "POST", "/api/notifications/recipients", {
    label: `QA322 Dupe WA ${runToken}`,
    email: `p322.wb.${runToken}@suse7.test`,
    whatsapp: sharedWa,
  });
  record(
    "duplicate_whatsapp_message_and_field",
    dupeWa.status === 409 &&
      dupeWa.json.error === "DUPLICATE_RECIPIENT" &&
      dupeWa.json.duplicated_field === "whatsapp" &&
      String(dupeWa.json.message).includes("WhatsApp já cadastrado"),
    `status=${dupeWa.status} field=${dupeWa.json.duplicated_field ?? ""}`
  );

  const list = await api(token, "GET", "/api/notifications/recipients");
  record(
    "list_returns_groups",
    list.status === 200 && Array.isArray(list.json.groups) && list.json.groups.length > 0,
    `groups=${list.json.groups?.length ?? 0}`
  );

  const groupId = personA.json.group?.group_id;
  if (groupId) {
    const patch = await api(token, "PATCH", `/api/notifications/recipients/${groupId}`, {
      label: `QA322 A Patched ${runToken}`,
    });
    record("patch_group_by_id", patch.status === 200, `status=${patch.status}`);

    const rulesPatch = await api(token, "PATCH", "/api/notifications/event-delivery-rules", {
      updates: [
        {
          category_code: SUITE_322_RULES_EVENT.category,
          type_key: SUITE_322_RULES_EVENT.type_key,
          recipient_group_id: groupId,
          channel: "email",
          enabled: true,
        },
      ],
    });
    record(
      "patch_event_delivery_rule",
      rulesPatch.status === 200 && Array.isArray(rulesPatch.json.rules),
      `status=${rulesPatch.status} event=${SUITE_322_RULES_EVENT.type_key} rules=${rulesPatch.json.rules?.length ?? "err"}`
    );

    const rulesGet = await api(token, "GET", "/api/notifications/event-delivery-rules");
    const hasRule = (rulesGet.json.rules ?? []).some(
      (r) =>
        r.recipient_group_id === groupId &&
        r.category_code === SUITE_322_RULES_EVENT.category &&
        r.type_key === SUITE_322_RULES_EVENT.type_key &&
        r.channel === "email" &&
        r.enabled === true
    );
    record("get_event_delivery_rules", rulesGet.status === 200 && hasRule, `status=${rulesGet.status}`);
  }

  const prefsPatchEmail = await api(token, "PATCH", "/api/notifications/preferences", {
    updates: [
      {
        category_code: "BILLING",
        type_key: "PAYMENT_CONFIRMED",
        channel: "email",
        enabled: false,
      },
    ],
  });
  record(
    "block_global_email_pref_patch",
    prefsPatchEmail.status === 400 && prefsPatchEmail.json.error === "CHANNEL_MANAGED_BY_RECIPIENTS",
    `status=${prefsPatchEmail.status}`
  );

  const prefsGet = await api(token, "GET", "/api/notifications/preferences");
  const billingPref = (prefsGet.json.preferences ?? []).find(
    (p) => p.category_code === "BILLING" && p.type_key === "PAYMENT_CONFIRMED"
  );
  const uiChannels = billingPref?.channels ? Object.keys(billingPref.channels) : [];
  record(
    "preferences_ui_in_app_only",
    prefsGet.status === 200 && uiChannels.length > 0 && !uiChannels.includes("email"),
    `channels=${uiChannels.join(",")}`
  );

  if (sb && sellerId) {
    await cleanupSuite322Run(sb, sellerId, runToken);
    record("isolation_cleanup", true, `runToken=${runToken}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
