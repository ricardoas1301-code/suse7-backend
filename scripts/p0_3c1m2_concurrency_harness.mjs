#!/usr/bin/env node
/**
 * P0.3-C.1M2 — concurrency harness DEV (parallel RPC sessions via Supabase).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

function refFromUrl(url) {
  try {
    const m = new URL(url).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function dbQuery(sql) {
  const out = execSync(`npx supabase db query --linked ${JSON.stringify(sql)}`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const jsonStart = out.indexOf("{");
  if (jsonStart < 0) throw new Error(`db query parse fail: ${out}`);
  const parsed = JSON.parse(out.slice(jsonStart));
  if (parsed._tag === "Error") throw new Error(parsed.error?.message ?? out);
  return parsed.rows ?? [];
}

const env = { ...parseEnvFile(path.join(root, ".env.local")) };
const ref = refFromUrl(env.SUPABASE_URL || "");
if (ref !== EXPECTED_REF) {
  console.error(JSON.stringify({ ok: false, error: "wrong_project", ref, expected: EXPECTED_REF }));
  process.exit(2);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const vUser = "7f85f0fb-a058-4dc1-9e01-09a9bdc923cc";
const vSub = "56a32441-b4ec-4de2-8657-0b237b8e4c15";
const vAcct = "359327e4-9902-4213-a1c3-1de702ef92ee";
const suffix = Date.now().toString(36);
const vCycle = `p0_3c1m2-conc-${suffix}`;
const vOrder = `CONC_${suffix}`;
const vOrderB = `CONC_B_${suffix}`;
const token = randomUUID();

const metaBackupRows = dbQuery(`SELECT metadata::text AS metadata FROM billing_subscriptions WHERE id='${vSub}'`);
const metaBackup = metaBackupRows[0]?.metadata;

try {
  dbQuery(
    `UPDATE billing_subscriptions SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('quota_counting_started_at', '2026-01-01T00:00:00+00:00') WHERE id = '${vSub}';`,
  );

  async function promote(admissionId, tok = token) {
    const { data, error } = await sb.rpc("billing_promote_manual_review_pending_to_reservation_v1", {
      p_user_id: vUser,
      p_admission_id: admissionId,
      p_reservation_owner_token: tok,
      p_usage_limit: null,
      p_simulate_tx_failure: false,
    });
    if (error) throw error;
    return data;
  }

  async function finalize(admissionId) {
    const { data, error } = await sb.rpc("billing_finalize_manual_review_not_billable_v1", {
      p_user_id: vUser,
      p_admission_id: admissionId,
      p_classification_reason: "commercial_final",
    });
    if (error) throw error;
    return data;
  }

  function patchLimit(cycle, limit) {
    dbQuery(
      `UPDATE billing_subscriptions SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('suspension_fallback_active', true, 'effective_entitlement', 'BABY_INTERNAL_FREE', 'quota_counting_started_at', '2026-01-01T00:00:00+00:00', 'sales_limit_snapshot', ${limit}, 'usage_limit_cycle_key', '${cycle}', 'sales_limit_snapshot_cycle_key', '${cycle}', 'sales_limit_snapshot_materialized_at', now()) WHERE id = '${vSub}';`,
    );
  }

  // Test 1 — same pending, parallel promote
  const cycle1 = `${vCycle}-same`;
  patchLimit(cycle1, 5);
  const up1 = await sb.rpc("billing_upsert_manual_review_pending_v1", {
    p_user_id: vUser,
    p_subscription_id: vSub,
    p_cycle_key: cycle1,
    p_external_order_id: `SAME_${suffix}`,
    p_marketplace: "mercado_livre",
    p_marketplace_account_id: vAcct,
    p_period_class: "FRANQUIA_ELEGIVEL",
    p_classification_reason: "eligible_fixture",
    p_snapshot_origin: "operational_sync",
    p_official_order_at: new Date().toISOString(),
    p_next_recovery_at: new Date().toISOString(),
  });
  if (up1.error) throw up1.error;
  const pending1 = up1.data.admission_id;
  const [pA, pB] = await Promise.all([promote(pending1), promote(pending1)]);
  const slotSame = dbQuery(
    `SELECT billing_count_active_billable_slots('${vSub}'::uuid, '${cycle1}') AS slots`,
  )[0]?.slots;
  const rowSame = dbQuery(
    `SELECT admission_result FROM billing_billable_sale_admissions WHERE id='${pending1}'`,
  )[0]?.admission_result;

  // Test 2 — last slot, two different pendings
  const cycle2 = `${vCycle}-last`;
  patchLimit(cycle2, 1);
  const upA = await sb.rpc("billing_upsert_manual_review_pending_v1", {
    p_user_id: vUser,
    p_subscription_id: vSub,
    p_cycle_key: cycle2,
    p_external_order_id: `${vOrderB}_A`,
    p_marketplace: "mercado_livre",
    p_marketplace_account_id: vAcct,
    p_period_class: "FRANQUIA_ELEGIVEL",
    p_classification_reason: "eligible_a",
    p_snapshot_origin: "operational_sync",
    p_official_order_at: new Date().toISOString(),
    p_next_recovery_at: new Date().toISOString(),
  });
  const upB2 = await sb.rpc("billing_upsert_manual_review_pending_v1", {
    p_user_id: vUser,
    p_subscription_id: vSub,
    p_cycle_key: cycle2,
    p_external_order_id: `${vOrderB}_B`,
    p_marketplace: "mercado_livre",
    p_marketplace_account_id: vAcct,
    p_period_class: "FRANQUIA_ELEGIVEL",
    p_classification_reason: "eligible_b",
    p_snapshot_origin: "operational_sync",
    p_official_order_at: new Date().toISOString(),
    p_next_recovery_at: new Date().toISOString(),
  });
  const pendingA = upA.data.admission_id;
  const pendingB = upB2.data.admission_id;
  const [lA, lB] = await Promise.all([promote(pendingA, randomUUID()), promote(pendingB, randomUUID())]);
  const slotLast = dbQuery(
    `SELECT billing_count_active_billable_slots('${vSub}'::uuid, '${cycle2}') AS slots`,
  )[0]?.slots;

  // Test 3 — promote vs finalize race
  const cycle3 = `${vCycle}-race`;
  patchLimit(cycle3, 5);
  const upC = await sb.rpc("billing_upsert_manual_review_pending_v1", {
    p_user_id: vUser,
    p_subscription_id: vSub,
    p_cycle_key: cycle3,
    p_external_order_id: `RACE_${suffix}`,
    p_marketplace: "mercado_livre",
    p_marketplace_account_id: vAcct,
    p_period_class: "FRANQUIA_ELEGIVEL",
    p_classification_reason: "race_fixture",
    p_snapshot_origin: "operational_sync",
    p_official_order_at: new Date().toISOString(),
    p_next_recovery_at: new Date().toISOString(),
  });
  const pendingC = upC.data.admission_id;
  const [rProm, rFin] = await Promise.all([promote(pendingC, randomUUID()), finalize(pendingC)]);
  const rowRace = dbQuery(
    `SELECT admission_result FROM billing_billable_sale_admissions WHERE id='${pendingC}'`,
  )[0]?.admission_result;

  const okSame =
    rowSame === "RESERVED" &&
    Number(slotSame) === 1 &&
    Boolean(pA.promoted || pB.promoted) &&
    Boolean(pA.reason === "reservation_reused" || pB.reason === "reservation_reused" || pA.duplicate || pB.duplicate);

  const okLast =
    Number(slotLast) === 1 &&
    Boolean(
      (lA.promoted && lB.reason === "baby_hard_limit_reached") ||
        (lB.promoted && lA.reason === "baby_hard_limit_reached"),
    );

  const okRace = ["RESERVED", "FINAL_NOT_BILLABLE"].includes(rowRace);

  const result = {
    ok: okSame && okLast && okRace,
    same_pending: { pA, pB, rowSame, slotSame, pass: okSame },
    last_slot: { lA, lB, slotLast, pass: okLast },
    promote_vs_finalize: { rProm, rFin, rowRace, pass: okRace },
  };

  if (!result.ok) {
    console.error("[P0.3-C.1M2 concurrency] FAIL", JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log("[P0.3-C.1M2 concurrency] OK", JSON.stringify(result, null, 2));
} finally {
  dbQuery(
    `DELETE FROM billing_billable_sale_admissions WHERE subscription_id = '${vSub}' AND cycle_key LIKE 'p0_3c1m2-conc-%';`,
  );
  if (metaBackup) {
    dbQuery(`UPDATE billing_subscriptions SET metadata = '${metaBackup.replace(/'/g, "''")}'::jsonb WHERE id = '${vSub}'`);
  }
}
