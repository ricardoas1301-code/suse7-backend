#!/usr/bin/env node
/**
 * P0.3-C.1M3 — concurrency harness DEV (C1–C5).
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
const vCycle = `p0_3c1m3-conc-${suffix}`;

const metaBackupRows = dbQuery(`SELECT metadata::text AS metadata FROM billing_subscriptions WHERE id='${vSub}'`);
const metaBackup = metaBackupRows[0]?.metadata;

function patchBabyMeta(cycle, limit = 5) {
  dbQuery(
    `UPDATE billing_subscriptions SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('suspension_fallback_active', true, 'effective_entitlement', 'BABY_INTERNAL_FREE', 'quota_counting_started_at', '2026-01-01T00:00:00+00:00', 'sales_limit_snapshot', ${limit}, 'usage_limit_cycle_key', '${cycle}', 'fallback_period_start', '${cycle}', 'fallback_period_end', '2026-12-31', 'sales_limit_snapshot_cycle_key', '${cycle}', 'sales_limit_snapshot_materialized_at', now()) WHERE id = '${vSub}';`,
  );
}

async function upsertUnresolved(order) {
  const { data, error } = await sb.rpc("billing_upsert_manual_review_pending_v2", {
    p_user_id: vUser,
    p_subscription_id: vSub,
    p_cycle_key: null,
    p_external_order_id: order,
    p_marketplace: "mercado_livre",
    p_marketplace_account_id: vAcct,
    p_period_class: "MANUAL_REVIEW",
    p_classification_reason: "quota_counting_started_at_missing",
    p_snapshot_origin: "operational_sync",
    p_official_order_at: new Date().toISOString(),
    p_next_recovery_at: new Date().toISOString(),
  });
  if (error) throw error;
  return data;
}

async function resolve(admissionId, cycle) {
  const { data, error } = await sb.rpc("billing_resolve_pending_cycle_v1", {
    p_user_id: vUser,
    p_admission_id: admissionId,
    p_cycle_key: cycle,
    p_resolution_reason: "concurrency_harness",
  });
  if (error) throw error;
  return data;
}

async function promote(admissionId, tok = randomUUID()) {
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

try {
  patchBabyMeta(vCycle, 5);

  // C1 — parallel unresolved upsert same sale
  const orderC1 = `C1_${suffix}`;
  const [uA, uB] = await Promise.all([upsertUnresolved(orderC1), upsertUnresolved(orderC1)]);
  const cntC1 = dbQuery(
    `SELECT COUNT(*)::int AS c FROM billing_billable_sale_admissions WHERE subscription_id='${vSub}' AND external_order_id='${orderC1}' AND admission_result='PENDING_MANUAL_REVIEW'`,
  )[0]?.c;
  const okC1 = cntC1 === 1 && (uA.admission_id === uB.admission_id || uA.duplicate || uB.duplicate);

  // C2 — parallel resolve same cycle
  const orderC2 = `C2_${suffix}`;
  const upC2 = await upsertUnresolved(orderC2);
  const pendingC2 = upC2.admission_id;
  const [rA, rB] = await Promise.all([resolve(pendingC2, vCycle), resolve(pendingC2, vCycle)]);
  const rowC2 = dbQuery(
    `SELECT cycle_key, pending_cycle_resolved_at IS NOT NULL AS resolved FROM billing_billable_sale_admissions WHERE id='${pendingC2}'`,
  )[0];
  const okC2 =
    rowC2?.cycle_key === vCycle &&
    rowC2?.resolved === true &&
    Boolean(rA.ok || rB.ok) &&
    (rA.reason === "cycle_resolved" || rA.reason === "cycle_already_resolved" || rB.reason === "cycle_resolved" || rB.reason === "cycle_already_resolved");

  // C3 — parallel conflicting resolve
  const orderC3 = `C3_${suffix}`;
  const upC3 = await upsertUnresolved(orderC3);
  const pendingC3 = upC3.admission_id;
  const cycleA = `${vCycle}-a`;
  const cycleB = `${vCycle}-b`;
  const [cA, cB] = await Promise.all([resolve(pendingC3, cycleA), resolve(pendingC3, cycleB)]);
  const rowC3 = dbQuery(`SELECT cycle_key FROM billing_billable_sale_admissions WHERE id='${pendingC3}'`)[0];
  const okC3 =
    (rowC3?.cycle_key === cycleA || rowC3?.cycle_key === cycleB) &&
    (cA.reason === "cycle_mismatch" || cB.reason === "cycle_mismatch" || cA.resolved || cB.resolved);

  // C4 — resolve vs finalize
  const orderC4 = `C4_${suffix}`;
  const upC4 = await upsertUnresolved(orderC4);
  const pendingC4 = upC4.admission_id;
  const [c4r, c4f] = await Promise.all([resolve(pendingC4, `${vCycle}-race`), finalize(pendingC4)]);
  const rowC4 = dbQuery(
    `SELECT admission_result, cycle_key FROM billing_billable_sale_admissions WHERE id='${pendingC4}'`,
  )[0];
  const okC4 = ["PENDING_MANUAL_REVIEW", "FINAL_NOT_BILLABLE"].includes(rowC4?.admission_result);

  // C5 — resolve/promote orchestration
  const orderC5 = `C5_${suffix}`;
  const cycle5 = `${vCycle}-promo`;
  patchBabyMeta(cycle5, 5);
  const upC5 = await upsertUnresolved(orderC5);
  const pendingC5 = upC5.admission_id;
  const prePromote = await promote(pendingC5);
  await resolve(pendingC5, cycle5);
  const promoToken = randomUUID();
  const postPromote1 = await promote(pendingC5, promoToken);
  const postPromote2 = await promote(pendingC5, promoToken);
  const slotC5 = dbQuery(
    `SELECT billing_count_active_billable_slots('${vSub}'::uuid, '${cycle5}') AS slots`,
  )[0]?.slots;
  const okC5 =
    prePromote.reason === "cycle_unresolved" &&
    postPromote1.promoted === true &&
    Number(slotC5) === 1 &&
    Boolean(postPromote2.duplicate || postPromote2.reason === "reservation_reused");

  const result = {
    ok: okC1 && okC2 && okC3 && okC4 && okC5,
    C1: { cntC1, uA, uB, pass: okC1 },
    C2: { rA, rB, rowC2, pass: okC2 },
    C3: { cA, cB, rowC3, pass: okC3 },
    C4: { c4r, c4f, rowC4, pass: okC4 },
    C5: { prePromote, postPromote1, postPromote2, slotC5, pass: okC5 },
  };

  if (!result.ok) {
    console.error("[P0.3-C.1M3 concurrency] FAIL", JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log("[P0.3-C.1M3 concurrency] OK", JSON.stringify(result, null, 2));
} finally {
  dbQuery(
    `DELETE FROM billing_billable_sale_admissions WHERE subscription_id='${vSub}' AND (external_order_id LIKE 'C%_${suffix}' OR external_order_id LIKE 'C%_mt3%' OR cycle_key LIKE 'p0_3c1m3-conc-%');`,
  );
  if (metaBackup) {
    dbQuery(
      `UPDATE billing_subscriptions SET metadata='${metaBackup.replace(/'/g, "''")}'::jsonb WHERE id='${vSub}';`,
    );
  }
}
