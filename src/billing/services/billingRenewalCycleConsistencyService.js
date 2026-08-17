// ======================================================================
// Consistência — no máximo 1 renewal cycle OPEN por assinatura (Fase 2.1)
// ======================================================================

import {
  RENEWAL_CYCLE_OPEN_STATUS_PRIORITY,
  RENEWAL_CYCLE_OPEN_STATUSES,
  RENEWAL_ENGINE_LOG,
  RENEWAL_STATUS,
} from "../billingConstants.js";
import { logBilling, logBillingRenewalConsistency } from "../billingLog.js";

/**
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function compareOpenRenewalCyclesForCanonical(a, b) {
  const rankA = RENEWAL_CYCLE_OPEN_STATUS_PRIORITY[String(a.renewal_status)] ?? 99;
  const rankB = RENEWAL_CYCLE_OPEN_STATUS_PRIORITY[String(b.renewal_status)] ?? 99;
  if (rankA !== rankB) return rankA - rankB;

  const createdA = new Date(String(a.created_at ?? 0)).getTime();
  const createdB = new Date(String(b.created_at ?? 0)).getTime();
  if (createdA !== createdB) return createdB - createdA;

  return String(b.id).localeCompare(String(a.id));
}

/**
 * @param {Record<string, unknown>[]} cycles
 */
export function pickCanonicalOpenRenewalCycle(cycles) {
  if (!Array.isArray(cycles) || cycles.length === 0) return null;
  const sorted = [...cycles].sort(compareOpenRenewalCyclesForCanonical);
  return sorted[0] ?? null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 */
export async function listOpenRenewalCyclesForSubscription(supabase, subscriptionId) {
  const { data, error } = await supabase
    .from("billing_renewal_cycles")
    .select("*")
    .eq("subscription_id", subscriptionId)
    .in("renewal_status", [...RENEWAL_CYCLE_OPEN_STATUSES])
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} cycleId
 * @param {{ supersededByCycleId?: string | null; reason?: string }} [options]
 */
export async function supersedeRenewalCycle(supabase, cycleId, options = {}) {
  const now = new Date().toISOString();
  const { data: row, error: readErr } = await supabase
    .from("billing_renewal_cycles")
    .select("metadata")
    .eq("id", cycleId)
    .maybeSingle();
  if (readErr) throw readErr;

  const meta =
    row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? { .../** @type {Record<string, unknown>} */ (row.metadata) }
      : {};

  meta.superseded_at = now;
  meta.superseded_reason = options.reason ?? "duplicate_open_cycle";
  if (options.supersededByCycleId) {
    meta.superseded_by_cycle_id = options.supersededByCycleId;
  }

  const { data, error } = await supabase
    .from("billing_renewal_cycles")
    .update({
      renewal_status: RENEWAL_STATUS.SUPERSEDED,
      metadata: meta,
      updated_at: now,
    })
    .eq("id", cycleId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Garante no máximo 1 ciclo OPEN: fecha duplicados como SUPERSEDED e retorna o canônico.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ userId?: string | null; reason?: string; dryRun?: boolean }} [options]
 */
export async function reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, options = {}) {
  const openCycles = await listOpenRenewalCyclesForSubscription(supabase, subscriptionId);
  const canonicalCycle = pickCanonicalOpenRenewalCycle(
    openCycles.map((row) => /** @type {Record<string, unknown>} */ (row))
  );

  const cycleIds = openCycles.map((row) => String(row.id));
  const openCyclesCount = openCycles.length;

  if (openCyclesCount <= 1) {
    return {
      canonicalCycle,
      openCyclesCount,
      supersededCycleIds: [],
      resolutionStrategy: openCyclesCount === 0 ? "none_open" : "single_open_ok",
    };
  }

  const duplicates = openCycles.filter((row) => String(row.id) !== String(canonicalCycle?.id));
  const resolutionStrategy = "keep_most_advanced_supersede_rest";

  logBillingRenewalConsistency({
    subscription_id: subscriptionId,
    user_id: options.userId ?? null,
    open_cycles_count: openCyclesCount,
    cycle_ids: cycleIds,
    canonical_cycle_id: canonicalCycle?.id ?? null,
    resolution_strategy: resolutionStrategy,
    reason: options.reason ?? "reconcile_open_cycles",
  });

  logBilling("billing", RENEWAL_ENGINE_LOG.CONSISTENCY, {
    subscription_id: subscriptionId,
    open_cycles_count: openCyclesCount,
    canonical_cycle_id: canonicalCycle?.id ?? null,
    superseded_count: duplicates.length,
    resolution_strategy: resolutionStrategy,
  });

  /** @type {string[]} */
  const supersededCycleIds = [];
  if (!options.dryRun) {
    for (const dup of duplicates) {
      await supersedeRenewalCycle(supabase, String(dup.id), {
        supersededByCycleId: canonicalCycle?.id != null ? String(canonicalCycle.id) : null,
        reason: options.reason ?? "duplicate_open_cycle",
      });
      supersededCycleIds.push(String(dup.id));
    }
  } else {
    for (const dup of duplicates) {
      supersededCycleIds.push(String(dup.id));
    }
  }

  return {
    canonicalCycle,
    openCyclesCount,
    supersededCycleIds,
    resolutionStrategy,
  };
}
