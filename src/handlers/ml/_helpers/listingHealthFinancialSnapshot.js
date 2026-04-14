import { formatHealthDbError } from "./mlHealthSchemaCompat.js";

// ======================================================
// Histórico financeiro — snapshots em marketplace_listing_health_history
// Fonte de verdade: colunas persistidas em marketplace_listing_health.
// Comparação antes de gravar: evita duplicatas quando o sync não altera finanças.
// Multi-marketplace: marketplace + external_listing_id explícitos em cada linha.
// ======================================================

/**
 * @typedef {{
 *   reason: string;
 *   source: string;
 * }} FinancialSnapshotMeta
 */

export const SNAPSHOT_REASON = {
  HEALTH_SYNC: "health_sync",
  MANUAL_BACKFILL: "manual_backfill",
  REPRICING_UPDATE: "repricing_update",
  FINANCIAL_CORRECTION: "financial_correction",
  IMPORT_SYNC: "import_sync",
};

export const SNAPSHOT_SOURCE = {
  ML_HEALTH_SYNC: "ml_health_sync",
  ML_BACKFILL: "ml_backfill",
  ADMIN_FIX: "admin_fix",
  MIGRATION: "migration",
  SCHEDULED_JOB: "scheduled_job",
};

/** Campos que disparam novo snapshot quando qualquer um mudar (vs. estado anterior persistido). */
export const FINANCIAL_SNAPSHOT_COMPARE_KEYS = [
  "list_or_original_price_brl",
  "promotional_price_brl",
  "sale_fee_percent",
  "sale_fee_amount",
  "shipping_cost_amount",
  "marketplace_cost_reduction_amount",
  "marketplace_payout_amount",
  "shipping_cost_source",
  "marketplace_cost_reduction_source",
  "marketplace_payout_source",
];

/** @param {unknown} v */
function normScalar(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
  }
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  return s;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {Record<string, unknown>}
 */
export function pickFinancialSnapshotComparable(row) {
  const r = row && typeof row === "object" ? row : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of FINANCIAL_SNAPSHOT_COMPARE_KEYS) {
    out[k] = normScalar(/** @type {Record<string, unknown>} */ (r)[k]);
  }
  return out;
}

/**
 * @param {Record<string, unknown> | null | undefined} before
 * @param {Record<string, unknown> | null | undefined} after
 */
export function financialHealthComparableChanged(before, after) {
  if (!after || typeof after !== "object") return false;
  if (!before || typeof before !== "object") return true;
  const a = pickFinancialSnapshotComparable(before);
  const b = pickFinancialSnapshotComparable(after);
  for (const k of FINANCIAL_SNAPSHOT_COMPARE_KEYS) {
    const x = a[k];
    const y = b[k];
    if (x !== y && String(x ?? "") !== String(y ?? "")) return true;
  }
  return false;
}

/** @param {unknown} v */
function cloneJson(v) {
  if (v == null) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   marketplaceListingHealthId: string;
 *   userId: string;
 *   marketplace: string;
 *   externalListingId: string;
 *   row: Record<string, unknown>;
 *   snapshotReason: string;
 *   snapshotSource: string;
 * }} p
 */
export async function insertMarketplaceListingHealthFinancialSnapshot(supabase, p) {
  const r = p.row;
  const payload = {
    marketplace_listing_health_id: p.marketplaceListingHealthId,
    user_id: p.userId,
    marketplace: p.marketplace,
    external_listing_id: p.externalListingId,
    list_or_original_price_brl: r.list_or_original_price_brl ?? null,
    promotional_price_brl: r.promotional_price_brl ?? null,
    sale_fee_percent: r.sale_fee_percent ?? null,
    sale_fee_amount: r.sale_fee_amount ?? null,
    shipping_cost_amount: r.shipping_cost_amount ?? r.shipping_cost ?? null,
    shipping_cost_currency: r.shipping_cost_currency != null ? String(r.shipping_cost_currency) : "BRL",
    shipping_cost_source: r.shipping_cost_source ?? null,
    shipping_cost_context: r.shipping_cost_context ?? null,
    shipping_cost_label: r.shipping_cost_label ?? null,
    marketplace_payout_amount: r.marketplace_payout_amount ?? r.marketplace_payout_amount_brl ?? null,
    marketplace_payout_currency:
      r.marketplace_payout_currency != null && String(r.marketplace_payout_currency).trim() !== ""
        ? String(r.marketplace_payout_currency).trim()
        : "BRL",
    marketplace_payout_source: r.marketplace_payout_source ?? null,
    marketplace_cost_reduction_amount: r.marketplace_cost_reduction_amount ?? null,
    marketplace_cost_reduction_source: r.marketplace_cost_reduction_source ?? null,
    marketplace_cost_reduction_label: r.marketplace_cost_reduction_label ?? null,
    raw_json: cloneJson(r.raw_json),
    snapshot_reason: p.snapshotReason,
    snapshot_source: p.snapshotSource,
  };

  const { error } = await supabase.from("marketplace_listing_health_history").insert(payload);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   existingHealthRow: Record<string, unknown> | null;
 *   mergedRowForUpsert: Record<string, unknown>;
 *   marketplaceListingHealthId: string | null;
 *   userId: string;
 *   marketplace: string;
 *   externalListingId: string;
 *   snapshotReason: string;
 *   snapshotSource: string;
 * }} ctx
 * @returns {Promise<boolean>} true se gravou snapshot
 */
export async function maybeRecordListingHealthFinancialSnapshot(supabase, ctx) {
  if (process.env.ML_HEALTH_FINANCIAL_SNAPSHOT === "0") return false;
  if (!ctx.marketplaceListingHealthId || String(ctx.marketplaceListingHealthId).trim() === "") {
    return false;
  }
  if (!financialHealthComparableChanged(ctx.existingHealthRow, ctx.mergedRowForUpsert)) {
    return false;
  }
  await insertMarketplaceListingHealthFinancialSnapshot(supabase, {
    marketplaceListingHealthId: String(ctx.marketplaceListingHealthId),
    userId: ctx.userId,
    marketplace: ctx.marketplace,
    externalListingId: ctx.externalListingId,
    row: ctx.mergedRowForUpsert,
    snapshotReason: ctx.snapshotReason,
    snapshotSource: ctx.snapshotSource,
  });
  return true;
}

/**
 * Agenda gravação assíncrona para não bloquear o sync (microtask).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Parameters<typeof maybeRecordListingHealthFinancialSnapshot>[1]} ctx
 * @param {{ external_listing_id?: string }} [logCtx]
 */
export function scheduleListingHealthFinancialSnapshot(supabase, ctx, logCtx = {}) {
  if (process.env.ML_HEALTH_FINANCIAL_SNAPSHOT === "0") return;
  queueMicrotask(() => {
    void maybeRecordListingHealthFinancialSnapshot(supabase, ctx).catch((e) => {
      const supa = e && typeof e === "object" && "code" in /** @type {object} */ (e) ? e : null;
      console.warn("[ml/health] financial_snapshot_async_failed", {
        external_listing_id: logCtx.external_listing_id ?? null,
        message: e instanceof Error ? e.message : String(e),
        ...(supa ? formatHealthDbError(supa) : {}),
        note: "Falha no histórico não afeta o upsert de marketplace_listing_health. Verifique migration marketplace_listing_health_history e RLS.",
      });
    });
  });
}
