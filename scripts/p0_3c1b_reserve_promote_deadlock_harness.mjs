#!/usr/bin/env node
/**
 * P0.3-C.1B T20 REAL — reserve canonical path vs promote pending (same sub/cycle).
 *
 * Processo A: reserveBillableSaleV2 (service layer — mesmo RPC do pipeline Baby elegível)
 * Processo B: promoteManualReviewPendingToReservation (service layer)
 *
 * Fixture isolada: metadata backup/restore; orders T20_*; cleanup por cycle/round.
 * Não altera witness RF nem consome quota operacional persistente.
 *
 * Pré-requisito DEV: grant homologado 6.9A em billing_reserve_billable_sale_v2
 * (scripts/sql/billing_admission_atomic_grant_dev_v2_6_9a10.sql) — mesmo RPC do backend.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { reserveBillableSaleV2 } from "../src/billing/services/billingBillableSaleAdmissionService.js";
import {
  promoteManualReviewPendingToReservation,
  upsertManualReviewPendingAdmission,
} from "../src/billing/services/billingManualReviewPendingService.js";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUNDS = Number(process.env.P0_3C1B_T20_ROUNDS ?? 5);
const FIXTURE_CYCLE_CIVIL = "2026-08-01";
const FIXTURE_CYCLE_END = "2026-08-31";
const FIXTURE_OFFICIAL_AT = "2026-08-20T12:00:00+00:00";
const FIXTURE_LIMIT = 5;

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

function isDeadlockError(err) {
  const code = err && typeof err === "object" ? String(/** @type {{ code?: string }} */ (err).code ?? "") : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return code === "40P01" || /deadlock detected/i.test(message);
}

function normalizeServiceError(err) {
  if (!err || typeof err !== "object") return { message: String(err ?? ""), code: null };
  return {
    message: String(/** @type {{ message?: string }} */ (err).message ?? err),
    code: /** @type {{ code?: string }} */ (err).code ?? null,
    details: err,
  };
}

/** Fixture billing context — subscription RF real (legacy); isolamento via guard + cleanup. */
const FIXTURE_USER = "7f85f0fb-a058-4dc1-9e01-09a9bdc923cc";
const FIXTURE_SUB = "56a32441-b4ec-4de2-8657-0b237b8e4c15";
const FIXTURE_ACCT = "359327e4-9902-4213-a1c3-1de702ef92ee";
const WITNESS_RF = "2000018031307152";
const T20_ISOLATED_SUB = process.env.P0_3C1B_T20_ISOLATED_SUB_ID?.trim() || null;
const T20_ALLOW_RF_SUB = String(process.env.P0_3C1B_T20_ALLOW_RF_SUB ?? "").toLowerCase() === "true";

const env = { ...parseEnvFile(path.join(root, ".env.local")) };
const ref = refFromUrl(env.SUPABASE_URL || "");
if (ref !== EXPECTED_REF) {
  console.error(JSON.stringify({ ok: false, error: "wrong_project", ref, expected: EXPECTED_REF }));
  process.exit(2);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const grantCheck = dbQuery(
  "SELECT has_function_privilege('service_role', 'public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamptz, text)', 'EXECUTE') AS ok;",
);
const reserveGrantOk = Boolean(grantCheck[0]?.ok);

const metaBackupRows = dbQuery(`SELECT metadata::text AS metadata FROM billing_subscriptions WHERE id='${FIXTURE_SUB}'`);
const metaBackup = metaBackupRows[0]?.metadata;

/** @type {Array<Record<string, unknown>>} */
const roundResults = [];

function patchFixtureBabyMetadata(limit = FIXTURE_LIMIT) {
  dbQuery(
    `UPDATE billing_subscriptions SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('suspension_fallback_active', true, 'effective_entitlement', 'BABY_INTERNAL_FREE', 'quota_counting_started_at', '2026-01-01T00:00:00+00:00', 'sales_limit_snapshot', ${limit}, 'usage_limit_cycle_key', '${FIXTURE_CYCLE_CIVIL}', 'sales_limit_snapshot_cycle_key', '${FIXTURE_CYCLE_CIVIL}', 'fallback_period_start', '${FIXTURE_CYCLE_CIVIL}', 'fallback_period_end', '${FIXTURE_CYCLE_END}', 'sales_limit_snapshot_materialized_at', now()) WHERE id = '${FIXTURE_SUB}';`,
  );
}

function cleanupFixtureAdmissions(externalOrderIds, subscriptionId = FIXTURE_SUB) {
  if (!externalOrderIds.length) return;
  const inList = externalOrderIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
  dbQuery(
    `DELETE FROM billing_billable_sale_admissions WHERE subscription_id='${subscriptionId}' AND external_order_id IN (${inList});`,
  );
}

function countWitnessRf() {
  const rows = dbQuery(
    `SELECT admission_result, count(*)::int AS n FROM billing_billable_sale_admissions WHERE marketplace_account_id='359327e4-9902-4213-a1c3-1de702ef92ee' AND external_order_id='${WITNESS_RF}' GROUP BY admission_result;`,
  );
  return rows;
}

try {
  if (!reserveGrantOk) {
    const out = {
      ok: false,
      status: "NOT_PROVEN",
      reason: "canonical_reserve_v2_grant_missing",
      hint: "Apply homologated grant scripts/sql/billing_admission_atomic_grant_dev_v2_6_9a10.sql on DEV",
      reserve_grant_homologated: false,
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }

  if (!T20_ALLOW_RF_SUB && !T20_ISOLATED_SUB) {
    const out = {
      ok: false,
      status: "BLOCKED_ISOLATION",
      reason: "t20_requires_isolated_subscription",
      hint: "Set P0_3C1B_T20_ISOLATED_SUB_ID to a non-RF fixture subscription OR P0_3C1B_T20_ALLOW_RF_SUB=true with no concurrent backfill",
      fixture_sub: FIXTURE_SUB,
      witness: WITNESS_RF,
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(2);
  }

  const activeSub = T20_ISOLATED_SUB || FIXTURE_SUB;

  dbQuery(
    `DELETE FROM billing_billable_sale_admissions WHERE subscription_id='${activeSub}' AND (external_order_id LIKE 'T20P_%' OR external_order_id LIKE 'T20N_%');`,
  );

  patchFixtureBabyMetadata(FIXTURE_LIMIT);

  for (let round = 0; round < ROUNDS; round += 1) {
    const suffix = `${Date.now().toString(36)}_${round}`;
    const pendingOrder = `T20P_${suffix}`;
    const newOrder = `T20N_${suffix}`;
    const promoteToken = randomUUID();

    const pendingUpsert = await upsertManualReviewPendingAdmission(sb, FIXTURE_USER, {
      subscription_id: activeSub,
      cycle_key: FIXTURE_CYCLE_CIVIL,
      external_order_id: pendingOrder,
      marketplace: "mercado_livre",
      marketplace_account_id: FIXTURE_ACCT,
      period_class: "MANUAL_REVIEW",
      classification_reason: "t20_real_fixture",
      snapshot_origin: "operational_sync",
      official_order_at: FIXTURE_OFFICIAL_AT,
    });

    const admissionId = pendingUpsert?.admission_id != null ? String(pendingUpsert.admission_id) : "";
    if (!pendingUpsert?.ok || !admissionId) {
      roundResults.push({
        round,
        ok: false,
        reason: "pending_fixture_failed",
        pending: pendingUpsert,
      });
      continue;
    }

    const started = Date.now();
    /** @type {Record<string, unknown>} */
    let reserveOutcome = {};
    /** @type {Record<string, unknown>} */
    let promoteOutcome = {};
    let deadlock = false;

    try {
      const [reserveResult, promoteResult] = await Promise.all([
        reserveBillableSaleV2(sb, {
          userId: FIXTURE_USER,
          subscriptionId: activeSub,
          cycleKey: FIXTURE_CYCLE_CIVIL,
          externalOrderId: newOrder,
          marketplace: "mercado_livre",
          marketplaceAccountId: FIXTURE_ACCT,
          usageLimit: FIXTURE_LIMIT,
          officialOrderAt: FIXTURE_OFFICIAL_AT,
          snapshotOrigin: "operational_sync",
        }).then(
          (row) => ({ ok: true, path: "reserveBillableSaleV2", result: row }),
          (err) => ({ ok: false, path: "reserveBillableSaleV2", error: normalizeServiceError(err) }),
        ),
        promoteManualReviewPendingToReservation(sb, FIXTURE_USER, {
          admission_id: admissionId,
          reservation_owner_token: promoteToken,
          usage_limit: null,
        }).then(
          (row) => ({ ok: true, path: "promoteManualReviewPendingToReservation", result: row }),
          (err) => ({ ok: false, path: "promoteManualReviewPendingToReservation", error: normalizeServiceError(err) }),
        ),
      ]);

      reserveOutcome = reserveResult;
      promoteOutcome = promoteResult;
      deadlock =
        isDeadlockError(reserveResult.error?.details) || isDeadlockError(promoteResult.error?.details);
    } catch (err) {
      deadlock = isDeadlockError(err);
      roundResults.push({
        round,
        elapsed_ms: Date.now() - started,
        deadlock,
        parallel_throw: normalizeServiceError(err),
      });
      cleanupFixtureAdmissions([pendingOrder, newOrder], activeSub);
      if (deadlock) break;
      continue;
    }

    const elapsedMs = Date.now() - started;
    const reserveRow =
      reserveOutcome.result && typeof reserveOutcome.result === "object"
        ? /** @type {Record<string, unknown>} */ (reserveOutcome.result)
        : {};
    const promoteRow =
      promoteOutcome.result && typeof promoteOutcome.result === "object"
        ? /** @type {Record<string, unknown>} */ (promoteOutcome.result)
        : {};

    const activeSlots = dbQuery(
      `SELECT public.billing_count_active_billable_slots('${activeSub}'::uuid, '${FIXTURE_CYCLE_CIVIL}') AS slots`,
    )[0]?.slots;

    const reserveReachedRpc =
      Boolean(reserveRow.atomic) ||
      reserveRow.reason === "baby_within_limit" ||
      reserveRow.admit === true ||
      reserveRow.admission_id != null;

    const promoteReachedRpc =
      Boolean(promoteRow.ok) || promoteRow.promoted === true || promoteRow.reason != null;

    roundResults.push({
      round,
      elapsed_ms: elapsedMs,
      deadlock,
      reserve_reached_real_path: reserveReachedRpc,
      promote_reached_real_path: promoteReachedRpc,
      reserve_admit: reserveRow.admit ?? null,
      reserve_atomic: reserveRow.atomic ?? null,
      reserve_reason: reserveRow.reason ?? reserveOutcome.error?.message ?? null,
      reserve_error_code: reserveOutcome.error?.code ?? null,
      promote_ok: promoteRow.ok ?? null,
      promote_reason: promoteRow.reason ?? promoteOutcome.error?.message ?? null,
      promote_error_code: promoteOutcome.error?.code ?? null,
      active_slots: activeSlots,
      usage_limit: FIXTURE_LIMIT,
      quota_overflow: Number(activeSlots ?? 0) > FIXTURE_LIMIT,
    });

    cleanupFixtureAdmissions([pendingOrder, newOrder], activeSub);

    if (deadlock) break;
  }

  const witnessAfter = countWitnessRf();
  const anyDeadlock = roundResults.some((r) => r.deadlock === true);
  const allReserveReal = roundResults.every((r) => r.reserve_reached_real_path === true);
  const allPromoteReal = roundResults.every((r) => r.promote_reached_real_path === true);
  const anyQuotaOverflow = roundResults.some((r) => r.quota_overflow === true);
  const proven =
    !anyDeadlock &&
    allReserveReal &&
    allPromoteReal &&
    !anyQuotaOverflow &&
    roundResults.length === ROUNDS &&
    roundResults.every((r) => r.reserve_atomic === true);

  const out = {
    ok: proven,
    status: proven ? "PASS" : anyDeadlock ? "BLOCKED_DEADLOCK" : "NOT_PROVEN",
    rounds: ROUNDS,
    canonical_paths: {
      reserve:
        "reserveBillableSaleV2 (billingBillableSaleAdmissionService — RPC billing_reserve_billable_sale_v2)",
      promote:
        "promoteManualReviewPendingToReservation → billing_promote_manual_review_pending_to_reservation_v1",
      note:
        "Fixture RF/internal_free não aciona reserve v2 via preflight paid_plan; service reserveBillableSaleV2 é o lock path atômico canônico do backend Baby.",
    },
    reserve_grant_homologated: reserveGrantOk,
    grant_source: "scripts/sql/billing_admission_atomic_grant_dev_v2_6_9a10.sql",
    round_results: roundResults,
    rf_witness_admissions: witnessAfter,
    recommendation: anyDeadlock
      ? "P0.3-C.1 BLOCKED — deadlock detected; RCA required before workflow_dispatch"
      : proven
        ? "T20 PASS — authorized for single workflow_dispatch"
        : "T20 NOT PROVEN — both paths must reach real RPC outcomes without deadlock",
  };

  const outPath = path.join(root, "scripts/output/P0_3C1B_T20_RESERVE_PROMOTE_REAL.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(proven ? 0 : 1);
} finally {
  if (metaBackup != null) {
    dbQuery(
      `UPDATE billing_subscriptions SET metadata='${metaBackup.replace(/'/g, "''")}'::jsonb WHERE id='${FIXTURE_SUB}';`,
    );
  }
  cleanupFixtureAdmissions([]);
}
