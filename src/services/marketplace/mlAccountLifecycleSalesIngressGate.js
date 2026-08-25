// ======================================================================
// Gate de lifecycle — ingress de vendas (poll/webhook) só após conta pronta.
// CPJ-0001 S1.12 — fail-closed enquanto masters + monitoramento não estão done.
// ======================================================================

import { ML_LISTINGS_TYPES } from "./createMlInitialSyncJobs.js";

const PRODUCTS_JOB = "ml_initial_products";
const FEES_JOB = "ml_initial_fees";
const WEBHOOK_JOB = "ml_enable_webhook_monitoring";

/**
 * Conta pronta para ingress incremental de vendas (webhook-first + poll).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} marketplaceAccountId
 * @returns {Promise<{ ready: boolean; reason: string | null }>}
 */
export async function resolveMlAccountLifecycleReadyForSalesIngress(supabase, marketplaceAccountId) {
  const accountId = String(marketplaceAccountId || "").trim();
  if (!accountId) return { ready: false, reason: "missing_marketplace_account_id" };

  const needed = [...ML_LISTINGS_TYPES, FEES_JOB, PRODUCTS_JOB, WEBHOOK_JOB];
  const { data: jobs, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("job_type, status")
    .eq("marketplace_account_id", accountId)
    .in("job_type", needed);

  if (error) {
    return { ready: false, reason: `lifecycle_jobs_query_failed:${error.message}` };
  }

  const rows = Array.isArray(jobs) ? jobs : [];
  if (!rows.length) {
    // Sem jobs: conta ainda não engajou initial sync — bloquear poll/webhook sales.
    return { ready: false, reason: "initial_sync_not_engaged" };
  }

  const statusOf = (types) => {
    const list = Array.isArray(types) ? types : [types];
    const match = rows.filter((j) => list.includes(String(j.job_type)));
    if (!match.length) return null;
    return match.some((j) => String(j.status).toLowerCase() === "done") ? "done" : "pending";
  };

  const listings = statusOf(ML_LISTINGS_TYPES);
  if (listings !== "done") return { ready: false, reason: "blocked_until_ml_listings_done" };

  if (statusOf(FEES_JOB) !== "done") return { ready: false, reason: "blocked_until_ml_initial_fees_done" };
  if (statusOf(PRODUCTS_JOB) !== "done") return { ready: false, reason: "blocked_until_ml_initial_products_done" };
  if (statusOf(WEBHOOK_JOB) !== "done") {
    return { ready: false, reason: "blocked_until_ml_enable_webhook_monitoring_done" };
  }

  return { ready: true, reason: null };
}
