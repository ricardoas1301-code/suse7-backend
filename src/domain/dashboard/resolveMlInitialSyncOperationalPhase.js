// ======================================================================
// Fase operacional da sincronização inicial ML — SSOT para card flutuante.
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { ML_LISTINGS_TYPES } from "../../services/marketplace/createMlInitialSyncJobs.js";
import { resolveInitialSyncUniverseStable } from "./initialSyncUniverseStable.js";

const PRODUCTS_JOB_TYPE = "ml_initial_products";
const ACTIVE_JOB_STATUSES = new Set(["pending", "queued", "running", "processing"]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ phase: "none" | "awaiting_start" | "in_progress"; marketplace_account_id: string | null }>}
 */
export async function resolveMlInitialSyncOperationalPhase(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return { phase: "none", marketplace_account_id: null };

  const { data: accounts, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id, status, marketplace")
    .eq("user_id", uid)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .neq("status", "removed")
    .order("created_at", { ascending: false });

  if (accErr) throw accErr;
  const rows = Array.isArray(accounts) ? accounts : [];
  if (!rows.length) return { phase: "none", marketplace_account_id: null };

  const primaryAccountId = String(rows[0]?.id ?? "").trim() || null;

  const accountIds = rows.map((r) => String(r.id)).filter(Boolean);
  const { data: jobs, error: jobErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id, job_type, status")
    .in("marketplace_account_id", accountIds);

  if (jobErr) {
    const msg = String(jobErr.message ?? "").toLowerCase();
    if (String(jobErr.code ?? "") !== "42P01" && !msg.includes("does not exist")) {
      throw jobErr;
    }
    return { phase: "awaiting_start", marketplace_account_id: primaryAccountId };
  }

  const jobRows = Array.isArray(jobs) ? jobs : [];
  if (!jobRows.length) {
    return { phase: "awaiting_start", marketplace_account_id: primaryAccountId };
  }

  const hasActiveJob = jobRows.some((j) => ACTIVE_JOB_STATUSES.has(String(j?.status ?? "").trim().toLowerCase()));
  if (hasActiveJob) {
    return { phase: "in_progress", marketplace_account_id: primaryAccountId };
  }

  const universe = await resolveInitialSyncUniverseStable(supabase, uid);
  if (!universe.stable) {
    return { phase: "in_progress", marketplace_account_id: primaryAccountId };
  }

  const listingsDone = jobRows.some(
    (j) => ML_LISTINGS_TYPES.includes(String(j.job_type)) && String(j.status).toLowerCase() === "done",
  );
  const productsDone = jobRows.some(
    (j) => String(j.job_type) === PRODUCTS_JOB_TYPE && String(j.status).toLowerCase() === "done",
  );

  if (!listingsDone || !productsDone) {
    return { phase: "awaiting_start", marketplace_account_id: primaryAccountId };
  }

  return { phase: "none", marketplace_account_id: primaryAccountId };
}
