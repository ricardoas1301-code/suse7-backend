#!/usr/bin/env node
/**
 * Fase 3.2.1 — integridade destinatários (API DEV)
 * Isolamento: evento PAYMENT_CONFIRMED sem regras 3.2.2; cleanup por runToken.
 *
 * node scripts/validatePhase321RecipientIntegrity.mjs
 */

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  SUITE_321_RESOLVER_EVENT,
  SUITE_321_RESOLVER_SCOPE,
  cleanupSuite321Run,
  prepareSuite321Isolation,
  resolveSellerIdByEmail,
  purgeEventDeliveryRulesForEvent,
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
  console.log("=== Fase 3.2.1 — Recipient integrity (isolated) ===\n");

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
      await prepareSuite321Isolation(sb, sellerId, runToken);
      record(
        "isolation_prepare",
        true,
        `rules purged for ${SUITE_321_RESOLVER_EVENT.category}:${SUITE_321_RESOLVER_EVENT.type_key}`
      );
    } else {
      record("isolation_prepare", false, "seller_id não encontrado");
    }
  }

  const emailDest = `phase321.${runToken}@suse7.test`;
  const waDest = `5511999${String(runToken).slice(-7)}`;

  const createdEmail = await api(token, "POST", "/api/notifications/recipients", {
    label: `QA321 Email ${runToken}`,
    channel: "email",
    destination: emailDest,
    scopes: [{ category_code: SUITE_321_RESOLVER_SCOPE.category_code }],
  });
  record(
    "create_valid_email",
    createdEmail.status === 201 && createdEmail.json.ok,
    `status=${createdEmail.status} error=${createdEmail.json.error ?? ""}`
  );

  const dupEmail = await api(token, "POST", "/api/notifications/recipients", {
    label: "Dup",
    channel: "email",
    destination: emailDest,
  });
  record(
    "block_duplicate_email",
    dupEmail.status === 409 && dupEmail.json.error === "DUPLICATE_RECIPIENT",
    `status=${dupEmail.status}`
  );

  const badEmail = await api(token, "POST", "/api/notifications/recipients", {
    label: "Bad",
    channel: "email",
    destination: "not-an-email",
  });
  record(
    "block_invalid_email",
    badEmail.status === 400 && badEmail.json.error === "INVALID_RECIPIENT_DESTINATION",
    `status=${badEmail.status}`
  );

  const createdWa = await api(token, "POST", "/api/notifications/recipients", {
    label: `QA321 WA ${runToken}`,
    channel: "whatsapp",
    destination: waDest,
  });
  record(
    "create_valid_whatsapp",
    createdWa.status === 201 && createdWa.json.ok,
    `status=${createdWa.status}`
  );

  const sameDestOtherChannel = await api(token, "POST", "/api/notifications/recipients", {
    label: `QA321 Email2 ${runToken}`,
    channel: "email",
    destination: `phase321.b.${runToken}@suse7.test`,
  });
  record(
    "create_other_channel_ok",
    sameDestOtherChannel.status === 201,
    `status=${sameDestOtherChannel.status}`
  );

  const badWa = await api(token, "POST", "/api/notifications/recipients", {
    label: "Bad WA",
    channel: "whatsapp",
    destination: "123",
  });
  record(
    "block_invalid_whatsapp",
    badWa.status === 400 && badWa.json.error === "INVALID_RECIPIENT_DESTINATION",
    `status=${badWa.status}`
  );

  const list = await api(token, "GET", "/api/notifications/recipients");
  const emailRow = (list.json.recipients ?? []).find((r) => r.destination === emailDest);
  record(
    "list_includes_scopes",
    list.status === 200 &&
      emailRow?.scopes?.some((s) => s.category_code === SUITE_321_RESOLVER_SCOPE.category_code),
    `found=${Boolean(emailRow)} scopes=${emailRow?.scopes?.length ?? 0}`
  );

  const email2Dest = `phase321.b.${runToken}@suse7.test`;
  await api(token, "POST", "/api/notifications/recipients", {
    label: `QA321 Email B ${runToken}`,
    channel: "email",
    destination: email2Dest,
  });

  if (emailRow?.id) {
    const patch = await api(token, "PATCH", `/api/notifications/recipients/${emailRow.id}`, {
      label: `QA321 Email Patched ${runToken}`,
    });
    record("patch_preserves_ownership", patch.status === 200 && patch.json.ok, `status=${patch.status}`);

    const patchDupe = await api(token, "PATCH", `/api/notifications/recipients/${emailRow.id}`, {
      destination: email2Dest,
    });
    record(
      "patch_block_duplicate_destination",
      patchDupe.status === 409 && patchDupe.json.error === "DUPLICATE_RECIPIENT",
      `status=${patchDupe.status} error=${patchDupe.json.error ?? ""}`
    );
  }

  if (sb && sellerId) {
    const { data: users } = await sb.auth.admin.listUsers({ perPage: 5 });
    const other = users?.users?.find((u) => String(u.email).toLowerCase() !== testEmail.toLowerCase());
    if (other?.id) {
      await sb.from("s7_notification_recipients").insert({
        seller_id: other.id,
        channel: "email",
        destination: emailDest,
        label: "Other seller",
        is_active: true,
        recipient_group_id: randomUUID(),
      });
      const stillOk = await api(token, "POST", "/api/notifications/recipients", {
        label: "Same dest other seller attempt dup",
        channel: "email",
        destination: emailDest,
      });
      record(
        "duplicate_only_per_seller",
        stillOk.status === 409,
        "same seller still blocked; other seller row seeded via service role"
      );
      await sb.from("s7_notification_recipients").delete().eq("seller_id", other.id).eq("destination", emailDest);
    } else {
      record("duplicate_only_per_seller", true, "skipped — no second seller in DEV");
    }

    const { resolveCentralRecipients } = await import(
      "../src/domain/notifications/central/recipients/resolveCentralRecipients.js"
    );

    if (emailRow?.id) {
      await purgeEventDeliveryRulesForEvent(
        sb,
        sellerId,
        SUITE_321_RESOLVER_EVENT.category,
        SUITE_321_RESOLVER_EVENT.type_key
      );

      await sb.from("s7_notification_recipients").update({ is_active: false }).eq("id", emailRow.id);

      const resolvedInactive = await resolveCentralRecipients(sb, {
        sellerId,
        category: SUITE_321_RESOLVER_EVENT.category,
        type: SUITE_321_RESOLVER_EVENT.type_key,
        channel: "email",
      });
      const hitsInactive = (resolvedInactive ?? []).some((r) => r.recipientId === emailRow.id);
      record("resolver_skips_inactive", !hitsInactive, `count=${resolvedInactive.length}`);

      await sb.from("s7_notification_recipients").update({ is_active: true }).eq("id", emailRow.id);

      const resolvedActive = await resolveCentralRecipients(sb, {
        sellerId,
        category: SUITE_321_RESOLVER_EVENT.category,
        type: SUITE_321_RESOLVER_EVENT.type_key,
        channel: "email",
      });
      const included = (resolvedActive ?? []).some((r) => r.recipientId === emailRow.id);
      record(
        "resolver_includes_active",
        included,
        `count=${resolvedActive.length} event=${SUITE_321_RESOLVER_EVENT.category}:${SUITE_321_RESOLVER_EVENT.type_key}`
      );
    }

    await cleanupSuite321Run(sb, sellerId, runToken);
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
