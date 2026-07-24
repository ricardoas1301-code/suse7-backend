#!/usr/bin/env node
/**
 * S1.HF.6.9A.10 — validação estática (30 cenários + SSOT)
 * Sem DB / sem SQL execute / sem grant.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const base = read("supabase/migrations/20260722140000_s7_billing_billable_sale_admission_atomic.sql");
const hardening = read(
  "supabase/migrations/20260723140000_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql",
);
const precheck = read("scripts/sql/billing_admission_atomic_precheck_6_9a10.sql");
const postcheck = read("scripts/sql/billing_admission_atomic_postcheck_6_9a10.sql");
const grantDev = read("scripts/sql/billing_admission_atomic_grant_dev_v2_6_9a10.sql");
const postgrant = read("scripts/sql/billing_admission_atomic_postgrant_dev_6_9a10.sql");
const classReport = read("scripts/output/BILLING_ADMISSION_6_9A10_CYCLE_ORIGIN_CLASSIFICATION.md");
const precReport = read("scripts/output/BILLING_ADMISSION_6_9A10_ACCESS_PRECEDENCE.md");

const access = read("src/billing/services/billingAccessPrecedenceService.js");
const civil = read("src/billing/services/billingCivilCycleWindowService.js");
const quota = read("src/billing/services/billingQuotaEligibilityService.js");
const preflight = read("src/billing/services/billingBillableSalePreflightService.js");
const admission = read("src/billing/services/billingBillableSaleAdmissionService.js");
const hook = read("src/billing/services/billingBillableSaleEntitlementHook.js");
const pipeline = read(
  "src/modules/marketplaces/mercado-livre/sales/mlOrderWebhookBillableAdmissionPipeline.js",
);
const sync = read("src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js");
const persist = read("src/handlers/ml/_helpers/mlSalesPersist.js");
const reconcilerJob = read("src/billing/jobs/billingBillableSaleAdmissionReconcilerJob.js");
const reconcilerHttp = read("src/handlers/jobs/billingBillableSaleAdmissionReconcilerJob.js");
const constants = read("src/billing/billingConstants.js");
const persistTest = read("scripts/test_billing_persist_partial_admission_contract_6_9a10_unit.mjs");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

check(
  "0 single forward 6_9a10",
  !fs.existsSync(
    path.join(
      root,
      "supabase/migrations/20260723140000_s7_billing_billable_sale_admission_atomic_hardening_6_9a9.sql",
    ),
  ) && hardening.includes("S1.HF.6.9A.10"),
);

check(
  "1 security blocks trial",
  access.includes("security_or_revocation") &&
    preflight.includes("const precedence = resolveCanonicalAccessPrecedence") &&
    preflight.indexOf("const precedence = resolveCanonicalAccessPrecedence") <
      preflight.indexOf("shouldBypassAtomicQuotaReservation(overlay.metadata"),
);
check("2 financial recovery blocks", access.includes("FINANCIAL_RECOVERY_ONLY") && access.includes("financial_recovery_only"));
check("3 trial unlimited volume", quota.includes("trial_active_unlimited") && constants.includes("TRIAL_OBSERVADO"));
check(
  "4 date_created not date_closed",
  !/order\?\.date_closed|date_closed_marketplace/.test(quota) &&
    sync.includes("date_created_marketplace: orderDetail?.date_created") &&
    !pipeline.includes("date_closed"),
);
check("5 missing date manual review", preflight.includes("official_order_at_missing") || preflight.includes("manual_review_required"));
check(
  "6 date_closed never eligibility",
  !/parseIsoTimestamp\(order\?\.date_closed\)/.test(quota) &&
    classReport.includes("date_created") &&
    classReport.includes("date_closed"),
);
check("7 origin transported", pipeline.includes("snapshotOrigin") && sync.includes("snapshot_origin: snapshotOrigin"));
check("8 unknown not operational", sync.includes("BILLING_SNAPSHOT_ORIGIN.UNKNOWN") && !sync.includes('return "post_suse7_sale"'));
check("9 SP midnight", civil.includes("America/Sao_Paulo") && base.includes("America/Sao_Paulo"));
check("10 semi-open window", civil.includes("cycle_ends_at_exclusive") && quota.includes("isOfficialOrderInCycleWindow"));
check("11 next cycle excluded", base.includes("p_official_order_at >= (v_window->>'cycle_ends_at_exclusive')") || hardening.includes("cycle_ends_at_exclusive"));
check("12 eligible except 0", hardening.includes("eligible_sales EXCEPT") || hardening.includes("EXCEPT SELECT * FROM active_admissions"));
check("13 admissions except 0", hardening.includes("active_admissions EXCEPT") || hardening.includes("EXCEPT SELECT * FROM eligible_sales"));
check("14 incomplete aborts", hardening.includes("active_incomplete_identity_admissions"));
check("15 reconciler no null wildcard", !reconcilerJob.includes("marketplace_account_id: null") && base.includes("release_incomplete_identity"));
check("16 baseline baby pause owner", hardening.includes("BABY_QUOTA_ENGINE") && hardening.includes("MIGRATION_BASELINE"));
check("17 rollover keeps financial", base.includes("billing_internal_apply_access_precedence_after_baby_clear") && precReport.includes("FINANCIAL_RECOVERY_ONLY"));
check("18 rollover keeps security", access.includes("security_access_revoked") && base.includes("security_access_revoked"));
check(
  "19 release uses precedence",
  base.includes("apply_access_precedence_after_baby_clear") &&
    base.includes("hard_pause_owner"),
);
check("20 heartbeat serial", admission.includes("beatOnce") && !admission.includes("setInterval") && admission.includes("inFlight"));
check("21 heartbeat recovery", admission.includes("heartbeat_lease_lost") || admission.includes("BILLING_RESERVATION_LEASE_LOST"));
check("22 baby atomic required", hook.includes("atomic_admission_required") && !hook.includes("transitionOnBillableSaleRecorded"));
check("23 historical not trial log", hook.includes("BILLING_HISTORICAL_IMPORT_OBSERVED") && hook.includes("resolveObservationLogEvent"));
check("24 existing idempotent", sync.includes("existing_sale_idempotent") && pipeline.includes("gate.idempotent"));
check("25 persist partial finalize", persist.includes("persistMercadoLibreOrder") && persistTest.includes("sale_already_persisted") && base.includes("finalized_instead"));
check("26 reconciler retry", reconcilerJob.includes("maxRetries") && reconcilerJob.includes("BILLING_ADMISSION_RECONCILER_RETRY") && reconcilerHttp.includes("CRON_SECRET"));
check("27 archive 59/60/61", base.includes("ARCHIVE_READ_ONLY") && base.includes("HARD_PAUSED"));
check(
  "28 zero GET hard pause",
  pipeline.includes("ml_api_calls: 0") && sync.includes("ml_api_calls: 0"),
);
check("29 no delete sales", !hardening.includes("DELETE FROM public.sales_orders") && !hardening.includes("TRUNCATE"));
check("30 no billing provider", !admission.includes("asaas.create") && !hook.includes("stripe") && classReport.includes("Nenhuma cobrança"));

check("P reserve signature", base.includes("p_official_order_at") && base.includes("p_snapshot_origin") && grantDev.includes("timestamptz, text"));
check("P postgrant 7", postgrant.includes("= 7") && postgrant.includes("AS ok"));
check("P postcheck except", postcheck.includes("identity_except_both_ways"));
check("P precheck robust", precheck.includes("precheck_complete") || precheck.includes("sale_origin_strategy"));
check("P ssot generator", read("scripts/generate_billing_admission_hardening_6_9a10.mjs").includes("SSOT"));

if (failures.length) {
  console.error("[S1.HF.6.9A.10 migration static] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[S1.HF.6.9A.10 migration static] OK", { checks: 30 + 5 });
