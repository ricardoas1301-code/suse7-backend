// ======================================================
// Read-model persistido — pricing_current_state_projected_unit (Lista).
// Cálculo pesado: sync/job/modal. GET /api/ml/listings?local_only=1: só leitura.
// ======================================================

import {
  buildPricingCurrentStateRowContract,
  logPricingCurrentStateRowAudit,
} from "./buildPricingCurrentStateRowContract.js";

export const PRICING_CURRENT_STATE_READ_MODEL_KEY = "_suse7_pricing_current_state_read_model";

const HOMOLOG_LISTING_IDS = new Set([
  "MLB6086602390",
  "MLB6087428866",
  "MLB6784329822",
  "MLB6415546858",
]);

/**
 * @param {Record<string, unknown>} contract
 * @param {{ source?: string; calculatedAt?: string }} [meta]
 */
export function finalizePricingCurrentStateReadModel(contract, meta = {}) {
  const now = meta.calculatedAt ?? new Date().toISOString();
  const source = meta.source ?? contract?.pricing_source_trace?.engine_source ?? "persisted_read_model";

  return {
    ...contract,
    contract_kind: contract.contract_kind ?? "pricing_current_state_projected_unit",
    money_scale: "BRL_DECIMAL",
    calculated_at: contract.calculated_at ?? now,
    source_trace: {
      ...(contract.source_trace != null && typeof contract.source_trace === "object"
        ? /** @type {Record<string, unknown>} */ (contract.source_trace)
        : {}),
      ...(contract.pricing_source_trace != null && typeof contract.pricing_source_trace === "object"
        ? /** @type {Record<string, unknown>} */ (contract.pricing_source_trace)
        : {}),
      engine_source: source,
      read_model: true,
    },
    pricing_source_trace: {
      ...(contract.pricing_source_trace != null && typeof contract.pricing_source_trace === "object"
        ? /** @type {Record<string, unknown>} */ (contract.pricing_source_trace)
        : {}),
      engine_source: source,
      read_model: true,
    },
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function readPricingCurrentStateReadModelFromListing(listing) {
  if (!listing || typeof listing !== "object") return null;
  const raw =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;
  const stored = raw?.[PRICING_CURRENT_STATE_READ_MODEL_KEY];
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) return null;
  return /** @type {Record<string, unknown>} */ (stored);
}

/**
 * @param {Record<string, unknown>} gridRow
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function buildPricingCurrentStateReadModelMissContract(gridRow, listing = null) {
  const externalId =
    gridRow.external_listing_id != null
      ? String(gridRow.external_listing_id).trim()
      : listing?.external_listing_id != null
        ? String(listing.external_listing_id).trim()
        : null;

  return {
    contract_kind: "pricing_current_state_projected_unit",
    money_scale: "BRL_DECIMAL",
    listing_id: gridRow.id ?? listing?.id ?? null,
    external_listing_id: externalId,
    product_id: gridRow.product_id ?? listing?.product_id ?? null,
    sku: gridRow.sku ?? listing?.product_sku ?? listing?.seller_sku ?? null,
    account_id: gridRow.marketplace_account_id ?? listing?.marketplace_account_id ?? null,
    marketplace: gridRow.marketplace ?? listing?.marketplace ?? null,
    current_effective_price_brl: null,
    original_price_brl: null,
    selected_promotion_id: null,
    selected_promotion_name: null,
    selected_promotion_status: null,
    selected_listing_type: null,
    row_projected_payout_brl: null,
    row_projected_commission_brl: null,
    row_projected_freight_brl: null,
    row_projected_tax_brl: null,
    row_projected_product_cost_brl: null,
    row_projected_profit_brl: null,
    row_projected_profit_percent: null,
    calculated_at: null,
    missing_data_flags: ["pricing_current_state_not_calculated"],
    source_trace: { read_model: false, reason: "read_model_miss" },
  };
}

/**
 * Fallback leve quando o read-model persistido não existe — hidrata a partir da grid
 * (pricing_context, preços, net_proceeds) sem rodar engine PI em massa.
 * Não usa métricas históricas lifetime (contribution_profit_brl, you_receive_brl agregado).
 *
 * @param {Record<string, unknown>} gridRow
 * @param {Record<string, unknown> | null | undefined} [listing]
 */
export function buildPricingCurrentStateReadModelMissGridFallbackContract(gridRow, listing = null) {
  const base = buildPricingCurrentStateRowContract(gridRow);
  const externalId =
    base.external_listing_id != null
      ? String(base.external_listing_id).trim()
      : gridRow.external_listing_id != null
        ? String(gridRow.external_listing_id).trim()
        : listing?.external_listing_id != null
          ? String(listing.external_listing_id).trim()
          : null;

  const currentPrice =
    base.current_effective_price_brl ?? base.current_price_brl ?? base.current_price ?? null;

  /** @type {string[]} */
  const missingFlags = Array.isArray(base.missing_data_flags)
    ? base.missing_data_flags.filter((f) => f !== "pricing_current_state_not_calculated")
    : [];

  if (!missingFlags.includes("read_model_miss_grid_fallback")) {
    missingFlags.push("read_model_miss_grid_fallback");
  }

  const contract = {
    ...base,
    listing_id: base.listing_id ?? gridRow.id ?? listing?.id ?? null,
    external_listing_id: externalId,
    product_id: base.product_id ?? gridRow.product_id ?? listing?.product_id ?? null,
    sku: base.sku ?? gridRow.sku ?? listing?.product_sku ?? listing?.seller_sku ?? null,
    account_id: base.account_id ?? gridRow.marketplace_account_id ?? listing?.marketplace_account_id ?? null,
    current_effective_price_brl: currentPrice,
    row_projected_payout_brl: base.row_projected_payout_brl ?? base.projected_payout ?? null,
    row_projected_commission_brl: base.row_projected_commission_brl ?? base.projected_commission ?? null,
    row_projected_freight_brl: base.row_projected_freight_brl ?? base.projected_freight ?? null,
    row_projected_tax_brl: base.row_projected_tax_brl ?? base.projected_tax ?? null,
    row_projected_product_cost_brl:
      base.row_projected_product_cost_brl ?? base.product_cost_brl ?? base.current_product_cost ?? null,
    row_projected_profit_brl: base.row_projected_profit_brl ?? base.projected_profit_brl ?? null,
    row_projected_profit_percent:
      base.row_projected_profit_percent ?? base.projected_profit_percent ?? null,
    missing_data_flags: missingFlags,
    source_trace: {
      read_model: false,
      reason: "read_model_miss_grid_row_contract_fallback",
    },
    pricing_source_trace: {
      ...(base.pricing_source_trace != null && typeof base.pricing_source_trace === "object"
        ? /** @type {Record<string, unknown>} */ (base.pricing_source_trace)
        : {}),
      engine_source: "grid_row_contract_fallback",
      read_model: false,
    },
  };

  if (externalId && HOMOLOG_LISTING_IDS.has(externalId)) {
    logPricingCurrentStateRowAudit(contract);
  }

  return contract;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {Record<string, unknown>} contract
 * @param {{ source?: string }} [meta]
 */
export async function persistPricingCurrentStateReadModel(supabase, userId, listingId, contract, meta = {}) {
  const { data: row, error: readErr } = await supabase
    .from("marketplace_listings")
    .select("raw_json")
    .eq("user_id", userId)
    .eq("id", listingId)
    .maybeSingle();

  if (readErr) throw readErr;

  const prevRaw =
    row?.raw_json != null && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
      ? /** @type {Record<string, unknown>} */ (row.raw_json)
      : {};

  const readModel = finalizePricingCurrentStateReadModel(contract, {
    source: meta.source ?? "pricing_read_model_persist",
  });

  const nextRaw = {
    ...prevRaw,
    [PRICING_CURRENT_STATE_READ_MODEL_KEY]: readModel,
  };

  const { error: patchErr } = await supabase
    .from("marketplace_listings")
    .update({
      raw_json: nextRaw,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", listingId);

  if (patchErr) throw patchErr;
  return readModel;
}

/**
 * @param {Record<string, unknown>} contract
 */
export function logPricingReadModelHit(contract) {
  const externalId =
    contract.external_listing_id != null ? String(contract.external_listing_id).trim() : "";
  if (!HOMOLOG_LISTING_IDS.has(externalId)) return;

  console.info("[S7_PRICING_READ_MODEL_HIT]", {
    listing_id: contract.external_listing_id ?? contract.listing_id ?? null,
    current_effective_price_brl: contract.current_effective_price_brl ?? null,
    selected_promotion_name: contract.selected_promotion_name ?? null,
    row_projected_payout_brl: contract.row_projected_payout_brl ?? contract.projected_payout_brl ?? null,
    row_projected_commission_brl:
      contract.row_projected_commission_brl ?? contract.projected_commission_brl ?? null,
    row_projected_freight_brl: contract.row_projected_freight_brl ?? contract.projected_freight_brl ?? null,
    row_projected_tax_brl: contract.row_projected_tax_brl ?? contract.projected_tax_brl ?? null,
    row_projected_product_cost_brl:
      contract.row_projected_product_cost_brl ?? contract.projected_product_cost_brl ?? null,
    row_projected_profit_brl: contract.row_projected_profit_brl ?? contract.projected_profit_brl ?? null,
    row_projected_profit_percent:
      contract.row_projected_profit_percent ?? contract.projected_profit_percent ?? null,
    calculated_at: contract.calculated_at ?? null,
    source_contract: contract.contract_kind ?? "pricing_current_state_projected_unit",
  });
}

/**
 * @param {{
 *   gridRow: Record<string, unknown>;
 *   listing?: Record<string, unknown> | null;
 *   reason?: string;
 *   scheduledRecalc?: boolean;
 * }} p
 */
export function logPricingReadModelMiss(p) {
  const { gridRow, listing = null, reason = "read_model_not_found", scheduledRecalc = false } = p;
  console.info("[S7_PRICING_READ_MODEL_MISS]", {
    listing_id: gridRow.external_listing_id ?? gridRow.id ?? null,
    sku: gridRow.sku ?? listing?.product_sku ?? listing?.seller_sku ?? null,
    account_id: gridRow.marketplace_account_id ?? listing?.marketplace_account_id ?? null,
    reason,
    returned_null_fields: [
      "current_effective_price_brl",
      "row_projected_payout_brl",
      "row_projected_profit_brl",
      "row_projected_profit_percent",
    ],
    scheduled_recalc: scheduledRecalc,
  });
}

/**
 * @param {{
 *   totalListings: number;
 *   localOnly: boolean;
 *   readModelHits: number;
 *   readModelMisses: number;
 *   syncEngineRunsCount: number;
 *   skippedEngineRunsCount: number;
 *   durationMs: number;
 *   returnedHttpStatus?: number;
 * }} p
 */
export function logPricingListPerformance(p) {
  console.info("[S7_PRICING_LIST_PERFORMANCE]", {
    total_listings: p.totalListings,
    local_only: p.localOnly,
    read_model_hits: p.readModelHits,
    read_model_misses: p.readModelMisses,
    sync_engine_runs_count: p.syncEngineRunsCount,
    skipped_engine_runs_count: p.skippedEngineRunsCount,
    duration_ms: p.durationMs,
    returned_http_status: p.returnedHttpStatus ?? 200,
  });
}

/**
 * @param {unknown} raw
 * @returns {Set<string>}
 */
export function parseRecalcExternalListingIds(raw) {
  /** @type {Set<string>} */
  const out = new Set();
  if (raw == null) return out;
  for (const part of String(raw).split(/[,;\s]+/)) {
    const id = part.trim();
    if (id !== "") out.add(id);
  }
  return out;
}
