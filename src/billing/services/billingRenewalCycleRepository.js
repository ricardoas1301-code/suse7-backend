// ======================================================================

// Repositório — billing_renewal_cycles

// ======================================================================



import { RENEWAL_CYCLE_OPEN_STATUSES, RENEWAL_STATUS } from "../billingConstants.js";

import {

  listOpenRenewalCyclesForSubscription,

  reconcileOpenRenewalCyclesForSubscription,

} from "./billingRenewalCycleConsistencyService.js";

import { daysUntilRenewalDueSimulated } from "./billingRenewalTestTime.js";



/**

 * @param {unknown} value

 */

function asTrimmedString(value) {

  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {{

 *   userId: string;

 *   subscriptionId: string;

 *   currentPlanKey: string;

 *   currentPlanId: string | null;

 *   cycleStart: string;

 *   cycleEnd: string;

 *   renewalDueDate: string;

 *   renewalStrategy: string;

 *   renewalStatus: string;

 *   metadata?: Record<string, unknown>;

 * }} input

 */

export async function findRenewalCycleByIdempotency(supabase, input) {

  const { data, error } = await supabase

    .from("billing_renewal_cycles")

    .select("*")

    .eq("user_id", input.userId)

    .eq("subscription_id", input.subscriptionId)

    .eq("current_plan_key", input.currentPlanKey)

    .eq("cycle_start", input.cycleStart)

    .eq("cycle_end", input.cycleEnd)

    .in("renewal_status", [...RENEWAL_CYCLE_OPEN_STATUSES])

    .maybeSingle();

  if (error) throw error;

  return data;

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {Record<string, unknown>} input

 */

export async function insertRenewalCycle(supabase, input) {

  const now = new Date().toISOString();

  const row = {

    user_id: input.userId,

    subscription_id: input.subscriptionId,

    current_plan_key: input.currentPlanKey,

    current_plan_id: input.currentPlanId,

    cycle_start: input.cycleStart,

    cycle_end: input.cycleEnd,

    renewal_due_date: input.renewalDueDate,

    renewal_strategy: input.renewalStrategy,

    renewal_status: input.renewalStatus,

    provider: input.provider ?? "asaas",

    metadata: input.metadata ?? {},

    created_at: now,

    updated_at: now,

  };

  const { data, error } = await supabase.from("billing_renewal_cycles").insert(row).select("*").single();

  if (error) throw error;

  return data;

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} cycleId

 * @param {Record<string, unknown>} patch

 */

export async function updateRenewalCycle(supabase, cycleId, patch) {

  const { data, error } = await supabase

    .from("billing_renewal_cycles")

    .update({ ...patch, updated_at: new Date().toISOString() })

    .eq("id", cycleId)

    .select("*")

    .single();

  if (error) throw error;

  return data;

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} cycleId

 * @param {string} userId

 */

export async function getRenewalCycleForUser(supabase, cycleId, userId) {

  const { data, error } = await supabase

    .from("billing_renewal_cycles")

    .select("*")

    .eq("id", cycleId)

    .eq("user_id", userId)

    .maybeSingle();

  if (error) throw error;

  return data;

}



/**

 * Assinaturas com vencimento nos próximos N dias ou já vencidas (janela operacional).

 *

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {{ lookaheadDays?: number; limit?: number; now?: Date }} [options]

 */

export async function listSubscriptionsApproachingRenewal(supabase, options = {}) {

  const now = options.now instanceof Date ? options.now : new Date();

  const lookaheadDays = Number.isFinite(Number(options.lookaheadDays))

    ? Math.max(1, Number(options.lookaheadDays))

    : 7;

  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 200;

  const horizonMs = now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000;

  const gracePastMs = now.getTime() - resolveRenewalGraceDaysFromEnv() * 24 * 60 * 60 * 1000;



  const { data, error } = await supabase

    .from("billing_subscriptions")

    .select(

      "id, user_id, plan_id, plan_key, provider, provider_customer_id, provider_subscription_id, status, amount, currency, current_period_start, current_period_end, next_due_date, metadata, created_at, updated_at"

    )

    .in("status", ["active", "past_due", "pending"])

    .eq("provider", "asaas")

    .order("current_period_end", { ascending: true, nullsFirst: false })

    .limit(Math.max(limit * 3, limit));



  if (error) throw error;



  /** @type {Record<string, unknown>[]} */

  const rows = [];

  for (const row of data ?? []) {

    const due =

      row.current_period_end != null

        ? new Date(String(row.current_period_end)).getTime()

        : row.next_due_date != null

          ? new Date(`${String(row.next_due_date)}T12:00:00.000Z`).getTime()

          : null;

    if (due == null || Number.isNaN(due)) continue;

    if (due <= horizonMs || due >= gracePastMs) {

      rows.push(/** @type {Record<string, unknown>} */ (row));

    }

    if (rows.length >= limit) break;

  }

  return rows;

}



function resolveRenewalGraceDaysFromEnv() {

  const raw = Number(process.env.BILLING_RENEWAL_GRACE_PERIOD_DAYS ?? 10);

  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10;

}



/**

 * Ciclo OPEN canônico (reconcilia duplicados antes de retornar).

 *

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} subscriptionId

 * @param {{ userId?: string | null; reason?: string }} [options]

 */

export async function findOpenRenewalCycleForSubscription(supabase, subscriptionId, options = {}) {

  const { canonicalCycle } = await reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, {

    userId: options.userId ?? null,

    reason: options.reason ?? "find_open_renewal_cycle",

  });

  return canonicalCycle;

}



export { listOpenRenewalCyclesForSubscription, reconcileOpenRenewalCyclesForSubscription };



/**

 * @param {Record<string, unknown>} row

 */

export function readCycleMetadata(row) {

  const meta = row?.metadata && typeof row.metadata === "object" ? /** @type {Record<string, unknown>} */ (row.metadata) : {};

  return meta;

}



/**

 * @param {unknown} renewalDueDate

 */

export function daysUntilRenewalDue(renewalDueDate, now = new Date()) {

  return daysUntilRenewalDueSimulated(renewalDueDate, now);

}


