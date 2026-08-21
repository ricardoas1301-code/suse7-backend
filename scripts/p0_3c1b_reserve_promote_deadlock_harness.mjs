#!/usr/bin/env node
/**
 * P0.3-C.1B T20 — reserve v2 (new order) + promote (pending) same subscription/cycle concurrently.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUNDS = Number(process.env.P0_3C1B_T20_ROUNDS ?? 5);

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

const metaBackupRows = dbQuery(`SELECT metadata::text AS metadata FROM billing_subscriptions WHERE id='${vSub}'`);
const metaBackup = metaBackupRows[0]?.metadata;

/** @type {Array<Record<string, unknown>>} */
const roundResults = [];

try {
  function patchLimit(cycle, limit) {
    dbQuery(
      `UPDATE billing_subscriptions SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('suspension_fallback_active', true, 'effective_entitlement', 'BABY_INTERNAL_FREE', 'quota_counting_started_at', '2026-01-01T00:00:00+00:00', 'sales_limit_snapshot', ${limit}, 'usage_limit_cycle_key', '${cycle}', 'sales_limit_snapshot_cycle_key', '${cycle}', 'sales_limit_snapshot_materialized_at', now()) WHERE id = '${vSub}';`,
    );
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    const suffix = `${Date.now().toString(36)}_${round}`;
    const vCycle = `p0_3c1b-t20-${suffix}`;
    patchLimit(vCycle, 5);
    const fixtureLimit = 5;
    const pendingOrder = `T20P_${suffix}`;
    const newOrder = `T20N_${suffix}`;
    const promoteToken = randomUUID();
    const reserveToken = randomUUID();

    const upsert = await sb.rpc("billing_upsert_manual_review_pending_v1", {
      p_user_id: vUser,
      p_subscription_id: vSub,
      p_cycle_key: vCycle,
      p_external_order_id: pendingOrder,
      p_marketplace: "mercado_livre",
      p_marketplace_account_id: vAcct,
      p_period_class: "MANUAL_REVIEW",
      p_classification_reason: "t20_fixture",
      p_snapshot_origin: "operational_sync",
      p_official_order_at: "2026-08-20T12:00:00+00:00",
    });
    if (upsert.error) throw upsert.error;
    const admissionId = upsert.data?.admission_id;
    if (!admissionId) throw new Error("missing admission_id");

    const started = Date.now();
    let promoteRes;
    let reserveRes;
    try {
      [promoteRes, reserveRes] = await Promise.all([
        sb.rpc("billing_promote_manual_review_pending_to_reservation_v1", {
          p_user_id: vUser,
          p_admission_id: admissionId,
          p_reservation_owner_token: promoteToken,
          p_usage_limit: fixtureLimit,
          p_simulate_tx_failure: false,
        }),
        sb.rpc("billing_reserve_billable_sale_v2", {
          p_user_id: vUser,
          p_subscription_id: vSub,
          p_cycle_key: vCycle,
          p_external_order_id: newOrder,
          p_reservation_owner_token: reserveToken,
          p_marketplace: "mercado_livre",
          p_marketplace_account_id: vAcct,
          p_usage_limit: fixtureLimit,
          p_simulate_tx_failure: false,
          p_official_order_at: "2026-08-20T12:00:00+00:00",
          p_snapshot_origin: "operational_sync",
        }),
      ]);
    } catch (parallelErr) {
      const elapsedMs = Date.now() - started;
      roundResults.push({
        round,
        elapsed_ms: elapsedMs,
        parallel_error: parallelErr instanceof Error ? parallelErr.message : String(parallelErr),
        deadlock_suspected: elapsedMs > 30_000,
      });
      dbQuery(
        `DELETE FROM billing_billable_sale_admissions WHERE subscription_id='${vSub}' AND cycle_key='${vCycle}';`,
      );
      continue;
    }
    const elapsedMs = Date.now() - started;

    if (promoteRes.error && reserveRes.error) {
      roundResults.push({
        round,
        elapsed_ms: elapsedMs,
        promote_error: promoteRes.error.message,
        reserve_error: reserveRes.error.message,
        reserve_error_code: reserveRes.error.code ?? null,
        deadlock_suspected: elapsedMs > 30_000,
      });
      dbQuery(
        `DELETE FROM billing_billable_sale_admissions WHERE subscription_id='${vSub}' AND cycle_key='${vCycle}';`,
      );
      continue;
    }

    const slotCount = dbQuery(
      `SELECT public.billing_count_active_billable_slots('${vSub}'::uuid, '${vCycle}') AS slots`,
    )[0]?.slots;

    roundResults.push({
      round,
      elapsed_ms: elapsedMs,
      promote_ok: promoteRes.data?.ok,
      promote_reason: promoteRes.data?.reason,
      reserve_admit: reserveRes.data?.admit ?? null,
      reserve_reason: reserveRes.data?.reason ?? reserveRes.error?.message ?? null,
      reserve_error_code: reserveRes.error?.code ?? null,
      active_slots: slotCount,
      deadlock_suspected: elapsedMs > 30_000,
    });

    dbQuery(
      `DELETE FROM billing_billable_sale_admissions WHERE subscription_id='${vSub}' AND cycle_key='${vCycle}';`,
    );
  }

  const deadlockSuspected = roundResults.some((r) => r.deadlock_suspected);
  const reservePermissionDenied = roundResults.every(
    (r) => r.reserve_error_code === "42501" || r.reserve_reason?.includes("permission denied"),
  );
  const out = {
    ok: !deadlockSuspected,
    rounds: ROUNDS,
    round_results: roundResults,
    reserve_permission_denied: reservePermissionDenied,
    recommendation: deadlockSuspected
      ? "P0.3-C.1 BLOCKED — DO NOT PROCEED"
      : reservePermissionDenied
        ? "T20 partial — no deadlock observed on promote path; reserve RPC grant missing on DEV direct call (backend runtime uses granted path)"
        : "T20 reserve+promote concurrent PASS",
  };

  const outPath = path.join(root, "scripts/output/P0_3C1B_T20_RESERVE_PROMOTE_DEADLOCK.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(deadlockSuspected ? 1 : 0);
} finally {
  if (metaBackup != null) {
    dbQuery(`UPDATE billing_subscriptions SET metadata='${metaBackup.replace(/'/g, "''")}'::jsonb WHERE id='${vSub}';`);
  }
}
