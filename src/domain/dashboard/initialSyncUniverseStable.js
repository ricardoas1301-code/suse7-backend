// ======================================================================
// Universo SKU/custos estável — só contar pendências após masters importados.
// DEV.V2.ML-INITIAL-SYNC-ORDER-HISTORY-WINDOW-CLOSE.01E-E
// CPJ-2 T1 OBS2: masters = isEffectiveSyncSuccess (stubs maintenance NÃO contam).
// ======================================================================

import { ML_LISTINGS_TYPES } from "../../services/marketplace/createMlInitialSyncJobs.js";
import { isEffectiveSyncSuccess } from "../marketplace/isEffectiveSyncSuccess.js";

const LISTINGS_JOB_TYPES = [...ML_LISTINGS_TYPES];
const PRODUCTS_JOB_TYPE = "ml_initial_products";

/**
 * Avalia estabilidade a partir de jobs já carregados (testável / SSOT).
 * @param {string[]} accountIds
 * @param {Record<string, unknown>[]} jobs
 * @returns {{ stable: boolean; reason: string | null; accounts_checked: number }}
 */
export function evaluateInitialSyncUniverseStableFromJobs(accountIds, jobs) {
  const ids = Array.isArray(accountIds) ? accountIds.map((id) => String(id)).filter(Boolean) : [];
  const rows = Array.isArray(jobs) ? jobs : [];
  if (!ids.length) return { stable: true, reason: null, accounts_checked: 0 };
  if (!rows.length) return { stable: true, reason: null, accounts_checked: ids.length };

  for (const accId of ids) {
    const accJobs = rows.filter((j) => String(j?.marketplace_account_id ?? "") === accId);
    if (!accJobs.length) continue;

    const listingsDone = accJobs.some(
      (j) => LISTINGS_JOB_TYPES.includes(String(j?.job_type ?? "")) && isEffectiveSyncSuccess(j),
    );
    const productsDone = accJobs.some(
      (j) => String(j?.job_type ?? "") === PRODUCTS_JOB_TYPE && isEffectiveSyncSuccess(j),
    );

    if (!listingsDone || !productsDone) {
      return {
        stable: false,
        reason: "initial_sync_masters_in_progress",
        accounts_checked: ids.length,
      };
    }
  }

  return { stable: true, reason: null, accounts_checked: ids.length };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ stable: boolean; reason: string | null; accounts_checked: number }>}
 */
export async function resolveInitialSyncUniverseStable(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return { stable: true, reason: null, accounts_checked: 0 };

  const { data: accounts, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id")
    .eq("user_id", uid)
    .eq("status", "active");

  if (accErr) throw accErr;
  const accountIds = (accounts || []).map((r) => String(r.id)).filter(Boolean);
  if (!accountIds.length) return { stable: true, reason: null, accounts_checked: 0 };

  const jobTypes = [...LISTINGS_JOB_TYPES, PRODUCTS_JOB_TYPE];
  const { data: jobs, error: jobErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id, job_type, status, metadata")
    .in("marketplace_account_id", accountIds)
    .in("job_type", jobTypes);

  if (jobErr) throw jobErr;
  return evaluateInitialSyncUniverseStableFromJobs(accountIds, jobs || []);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function isInitialSyncUniverseStableForUser(supabase, userId) {
  const r = await resolveInitialSyncUniverseStable(supabase, userId);
  return r.stable;
}
