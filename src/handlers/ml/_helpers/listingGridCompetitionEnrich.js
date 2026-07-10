// ======================================================
// Grid GET /api/ml/listings — métricas de concorrência (batch, sem N+1).
// Mesma base da Página Concorrência (competition_monitored_listings + competition_competitors).
// Nunca derruba o processo: fallback seguro + logs [S7_COMPETITION_METRICS_ENRICH_GUARD].
// ======================================================

import Decimal from "decimal.js";
import { findLatestSnapshotMetaForCompetitors } from "../../../domain/competition/competitionRepository.js";
import { toCompetitorResponse } from "../../../domain/competition/competitionNormalizer.js";

const GUARD_LOG_PREFIX = "[S7_COMPETITION_METRICS_ENRICH_GUARD]";
const ROUTE_LISTINGS = "/api/ml/listings";
const QUERY_CHUNK_SIZE = 80;
const QUERY_TIMEOUT_MS = 20_000;
const COMPETITION_PARITY_AUDIT_LISTING_IDS = new Set([
  "MLB6415546858",
  "MLB6086602390",
  "MLB6086959274",
  "MLB6248559698",
  "MLB4222539767",
  "MLB4222553029",
  "MLB5742208114",
  "MLB4439259905",
  "MLB6525945332",
  "MLB4684007879",
]);
const INACTIVE_COMPETITOR_LISTING_STATUSES = new Set([
  "paused",
  "closed",
  "inactive",
  "not_found",
  "under_review",
  "forbidden",
  "unavailable",
]);

/**
 * @param {unknown} raw
 * @returns {Decimal | null}
 */
function parsePriceDecimal(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const dec = new Decimal(String(raw).trim().replace(",", "."));
    return dec.isFinite() && dec.gte(0) ? dec : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown[]} items
 * @param {number} size
 */
function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * @param {Promise<T>} promise
 * @param {string} label
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 * @template T
 */
async function withCompetitionQueryTimeout(promise, label, timeoutMs = QUERY_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {{
 *   route?: string;
 *   listing_id?: string | null;
 *   marketplace_account_id?: string | null;
 *   error_name?: string;
 *   error_message?: string;
 *   duration_ms?: number;
 *   stage?: string;
 *   grid_rows?: number;
 * }} ctx
 */
function logCompetitionEnrichGuard(ctx) {
  console.warn(GUARD_LOG_PREFIX, {
    route: ctx.route ?? ROUTE_LISTINGS,
    listing_id: ctx.listing_id ?? null,
    marketplace_account_id: ctx.marketplace_account_id ?? null,
    error_name: ctx.error_name ?? "Error",
    error_message: ctx.error_message ?? "unknown",
    duration_ms: ctx.duration_ms ?? null,
    stage: ctx.stage ?? null,
    grid_rows: ctx.grid_rows ?? null,
    fallback_applied: true,
  });
}

/**
 * @param {Record<string, unknown>} gridRow
 * @param {string} source
 */
export function applyCompetitionMetricsFallbackToGridRow(gridRow, source = "unavailable") {
  gridRow.competitors_count = 0;
  gridRow.competitors_above_count = 0;
  gridRow.competitors_below_count = 0;
  gridRow.competition_list_source = source;
  gridRow.competition_status = source === "not_monitored" ? "not_monitored" : "unavailable";
  if (!Object.prototype.hasOwnProperty.call(gridRow, "monitored_listing_id")) {
    gridRow.monitored_listing_id = null;
  }
}

/**
 * @param {Record<string, unknown>[]} gridRows
 * @param {string} [source]
 */
export function applyCompetitionMetricsFallbackToAllGridRows(gridRows, source = "unavailable") {
  if (!Array.isArray(gridRows)) return;
  for (const gridRow of gridRows) {
    if (!gridRow || typeof gridRow !== "object") continue;
    applyCompetitionMetricsFallbackToGridRow(gridRow, source);
  }
}

/**
 * Preço atual praticado na grid (promo ativa → preço promocional).
 * @param {Record<string, unknown>} gridRow
 */
function resolveGridCurrentSalePrice(gridRow) {
  if (gridRow.promotion_active === true) {
    const promo = parsePriceDecimal(gridRow.promotion_sale_price_brl ?? gridRow.promotional_price_brl);
    if (promo != null && promo.gt(0)) return promo;
  }
  const eff = parsePriceDecimal(gridRow.effective_sale_price_brl);
  if (eff != null && eff.gt(0)) return eff;
  const current = parsePriceDecimal(gridRow.price_brl);
  if (current != null && current.gt(0)) return current;
  const list = parsePriceDecimal(gridRow.listing_price_brl ?? gridRow.listing_sale_price_brl);
  return list != null && list.gt(0) ? list : null;
}

/**
 * @param {Record<string, unknown>} gridRow
 */
function shouldAuditCompetitionParity(gridRow) {
  if (process.env.NODE_ENV === "production") return false;
  if (
    process.env.S7_PRECIFICACOES_COMPETITION_COUNT_PARITY === "1" ||
    process.env.S7_PRECIFICACOES_COMPETITION_DIRECTION_AUDIT === "1"
  ) {
    return true;
  }
  const externalId = gridRow.external_listing_id != null ? String(gridRow.external_listing_id).trim() : "";
  return COMPETITION_PARITY_AUDIT_LISTING_IDS.has(externalId);
}

/**
 * @param {Record<string, unknown>} comp
 * @param {Record<string, unknown> | undefined} meta
 */
function normalizeCompetitionCompetitorForPrecificacoes(comp, meta) {
  return toCompetitorResponse(comp, {
    sales_hint: meta?.sales_hint ?? null,
    shipping: meta?.shipping ?? null,
    listing_type: meta?.listing_type ?? null,
    reputation: meta?.reputation ?? null,
    snapshot_thumbnail: meta?.competitor_thumbnail ?? null,
    snapshot_store_name: meta?.competitor_store_name ?? null,
    snapshot_price: meta?.competitor_price ?? null,
    snapshot_title: meta?.competitor_title ?? null,
    snapshot_captured_at: meta?.captured_at ?? null,
    listing_status: meta?.listing_status ?? null,
    competitor_pictures: meta?.competitor_pictures ?? null,
  });
}

/**
 * Mesma regra visual da Página Concorrência: concorrente cadastrado localmente mas
 * pausado/fechado no marketplace não entra no comparativo acima/abaixo.
 * @param {Record<string, unknown>} competitor
 */
function isActiveCompetitorListingForComparison(competitor) {
  const status =
    competitor?.competitor_listing_status != null
      ? String(competitor.competitor_listing_status).trim().toLowerCase()
      : "";
  if (!status) return true;
  if (status === "active") return true;
  return !INACTIVE_COMPETITOR_LISTING_STATUSES.has(status);
}

/**
 * @param {{
 *   listingId: string | null;
 *   marketplaceAccountId?: string | null;
 *   myEffectivePrice: Decimal | null;
 *   competitors: Record<string, unknown>[];
 *   snapshotMeta: Map<string, Record<string, unknown>>;
 * }} params
 */
export function resolvePrecificacoesCompetitionSummary({
  listingId,
  marketplaceAccountId = null,
  myEffectivePrice,
  competitors,
  snapshotMeta,
}) {
  let above = 0;
  let below = 0;
  let equal = 0;
  let ignored = 0;
  const details = [];
  const list = Array.isArray(competitors) ? competitors : [];

  for (const comp of list) {
    const meta = snapshotMeta.get(comp.id) ?? {};
    const normalized = normalizeCompetitionCompetitorForPrecificacoes(comp, meta);
    const competitorId = normalized.competitor_listing_id ?? comp.competitor_listing_id ?? comp.id ?? null;
    const competitorTitle = normalized.competitor_title ?? comp.competitor_title ?? null;
    const competitorPrice = parsePriceDecimal(normalized.last_seen_price);
    const baseDetail = {
      competitor_listing_id: competitorId,
      competitor_title: competitorTitle,
      competitor_price: competitorPrice != null ? competitorPrice.toFixed(2) : null,
      diff: null,
      resolved_direction: "ignored",
      ignored_reason: null,
    };

    if (!isActiveCompetitorListingForComparison(normalized)) {
      ignored += 1;
      details.push({
        ...baseDetail,
        ignored_reason: `inactive_status:${normalized.competitor_listing_status ?? "unknown"}`,
      });
      continue;
    }

    if (competitorPrice == null || !competitorPrice.gt(0)) {
      ignored += 1;
      details.push({ ...baseDetail, ignored_reason: "invalid_competitor_price" });
      continue;
    }

    if (myEffectivePrice == null || !myEffectivePrice.gt(0)) {
      ignored += 1;
      details.push({ ...baseDetail, ignored_reason: "invalid_my_effective_price" });
      continue;
    }

    const diff = myEffectivePrice.minus(competitorPrice);
    let direction = "equal";
    if (diff.gt(0)) {
      above += 1;
      direction = "above";
    } else if (diff.lt(0)) {
      below += 1;
      direction = "below";
    } else {
      equal += 1;
    }

    details.push({
      ...baseDetail,
      diff: diff.toFixed(2),
      resolved_direction: direction,
      ignored_reason: null,
    });
  }

  return {
    listing_id: listingId,
    marketplace_account_id: marketplaceAccountId,
    total_valid_competitors: above + below + equal,
    above_count: above,
    below_count: below,
    equal_count: equal,
    ignored_count: ignored,
    competitors_raw_count: list.length,
    competitors: details,
    source: "competition_monitored_listings_batch.to_competitor_response",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} listingIds
 */
async function fetchMonitoredListingsBatched(supabase, userId, listingIds) {
  const chunks = chunkArray(listingIds, QUERY_CHUNK_SIZE);
  const settled = await Promise.allSettled(
    chunks.map((chunk) =>
      withCompetitionQueryTimeout(
        supabase
          .from("competition_monitored_listings")
          .select("id, marketplace_listing_id, external_listing_id")
          .eq("user_id", userId)
          .eq("is_monitored", true)
          .in("marketplace_listing_id", chunk),
        "competition_monitored_listings",
      ),
    ),
  );

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {Error[]} */
  const errors = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { data, error } = result.value;
      if (error) {
        errors.push(error instanceof Error ? error : new Error(String(error.message ?? error)));
        continue;
      }
      rows.push(...(data || []));
    } else {
      errors.push(
        result.reason instanceof Error ? result.reason : new Error(String(result.reason ?? "rejected")),
      );
    }
  }

  if (errors.length > 0 && rows.length === 0) {
    const first = errors[0];
    throw first;
  }
  if (errors.length > 0) {
    logCompetitionEnrichGuard({
      stage: "competition_monitored_listings_partial",
      error_name: errors[0]?.name ?? "Error",
      error_message: errors[0]?.message ?? String(errors[0]),
      grid_rows: listingIds.length,
    });
  }

  return rows;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} monitoredIds
 */
async function fetchCompetitorsBatched(supabase, userId, monitoredIds) {
  const chunks = chunkArray(monitoredIds, QUERY_CHUNK_SIZE);
  const settled = await Promise.allSettled(
    chunks.map((chunk) =>
      withCompetitionQueryTimeout(
        supabase
          .from("competition_competitors")
          .select(
            "id, monitored_listing_id, marketplace, product_id, sku, competitor_listing_id, competitor_title, competitor_store_name, competitor_thumbnail, competitor_permalink, source_strategy, last_seen_price, last_seen_currency, last_captured_at, is_active, competitor_listing_status",
          )
          .eq("user_id", userId)
          .eq("is_active", true)
          .in("monitored_listing_id", chunk),
        "competition_competitors",
      ),
    ),
  );

  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {Error[]} */
  const errors = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { data, error } = result.value;
      if (error) {
        errors.push(error instanceof Error ? error : new Error(String(error.message ?? error)));
        continue;
      }
      rows.push(...(data || []));
    } else {
      errors.push(
        result.reason instanceof Error ? result.reason : new Error(String(result.reason ?? "rejected")),
      );
    }
  }

  if (errors.length > 0 && rows.length === 0) {
    throw errors[0];
  }
  if (errors.length > 0) {
    logCompetitionEnrichGuard({
      stage: "competition_competitors_partial",
      error_name: errors[0]?.name ?? "Error",
      error_message: errors[0]?.message ?? String(errors[0]),
      grid_rows: monitoredIds.length,
    });
  }

  return rows;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} gridRows
 */
async function enrichListingGridRowsWithCompetitionMetricsCore(supabase, userId, gridRows) {
  const listingIds = [
    ...new Set(
      gridRows
        .map((r) => (r?.id != null ? String(r.id).trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (listingIds.length === 0) return;

  const monitoredRows = await fetchMonitoredListingsBatched(supabase, userId, listingIds);

  /** @type {Map<string, Record<string, unknown>>} */
  const monitoredByListingId = new Map();
  for (const row of monitoredRows) {
    const key = row?.marketplace_listing_id != null ? String(row.marketplace_listing_id).trim() : "";
    if (key) monitoredByListingId.set(key, /** @type {Record<string, unknown>} */ (row));
  }

  const monitoredIds = monitoredRows.map((r) => r.id).filter(Boolean);
  if (monitoredIds.length === 0) {
    for (const gridRow of gridRows) {
      applyCompetitionMetricsFallbackToGridRow(gridRow, "not_monitored");
    }
    return;
  }

  const comps = await fetchCompetitorsBatched(supabase, userId, monitoredIds.map(String));

  /** @type {Map<string, Record<string, unknown>>} */
  let snapshotMeta = new Map();
  try {
    snapshotMeta = await withCompetitionQueryTimeout(
      findLatestSnapshotMetaForCompetitors(
        supabase,
        userId,
        comps.map((r) => r.id).filter(Boolean),
      ),
      "competition_snapshot_meta",
    );
  } catch (metaErr) {
    const err = metaErr instanceof Error ? metaErr : new Error(String(metaErr));
    logCompetitionEnrichGuard({
      stage: "competition_snapshot_meta",
      error_name: err.name,
      error_message: err.message,
      grid_rows: gridRows.length,
    });
  }

  /** @type {Map<string, Record<string, unknown>[]>} */
  const compsByMonitored = new Map();
  for (const row of comps) {
    const key = String(row.monitored_listing_id);
    if (!compsByMonitored.has(key)) compsByMonitored.set(key, []);
    compsByMonitored.get(key).push(/** @type {Record<string, unknown>} */ (row));
  }

  for (const gridRow of gridRows) {
    const listingId = gridRow.id != null ? String(gridRow.id).trim() : "";
    const monitored = listingId ? monitoredByListingId.get(listingId) ?? null : null;

    if (!monitored) {
      applyCompetitionMetricsFallbackToGridRow(gridRow, "not_monitored");
      continue;
    }

    const competitors = compsByMonitored.get(String(monitored.id)) || [];
    const ourPrice = resolveGridCurrentSalePrice(gridRow);
    const summary = resolvePrecificacoesCompetitionSummary({
      listingId: gridRow.external_listing_id ?? gridRow.id ?? null,
      marketplaceAccountId:
        gridRow.marketplace_account_id != null ? String(gridRow.marketplace_account_id) : null,
      myEffectivePrice: ourPrice,
      competitors,
      snapshotMeta,
    });

    gridRow.competitors_count = summary.total_valid_competitors;
    gridRow.competitors_above_count = summary.above_count;
    gridRow.competitors_below_count = summary.below_count;
    gridRow.competitors_equal_count = summary.equal_count;
    gridRow.competitors_ignored_count = summary.ignored_count;
    gridRow.competition_list_source = summary.source;
    gridRow.competition_status = "available";
    gridRow.monitored_listing_id = monitored.id ?? null;

    if (shouldAuditCompetitionParity(gridRow)) {
      console.info("[S7_PRECIFICACOES_COMPETITION_COUNT_PARITY]", {
        listing_id: summary.listing_id,
        marketplace_account_id: summary.marketplace_account_id,
        my_effective_price: ourPrice != null ? ourPrice.toFixed(2) : null,
        competitors_raw_count: summary.competitors_raw_count,
        competitors_valid_count: summary.total_valid_competitors,
        ignored_count: summary.ignored_count,
        equal_count: summary.equal_count,
        above_count: summary.above_count,
        below_count: summary.below_count,
        rendered_total: gridRow.competitors_count,
        rendered_above: gridRow.competitors_above_count,
        rendered_below: gridRow.competitors_below_count,
        rendered_above_count: gridRow.competitors_above_count,
        rendered_below_count: gridRow.competitors_below_count,
        source: summary.source,
        competitors: summary.competitors,
      });
    }
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} gridRows
 */
export async function enrichListingGridRowsWithCompetitionMetrics(supabase, userId, gridRows) {
  const startedMs = Date.now();
  if (!Array.isArray(gridRows) || gridRows.length === 0) return;

  try {
    await enrichListingGridRowsWithCompetitionMetricsCore(supabase, userId, gridRows);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const sampleRow = gridRows.find((r) => r && typeof r === "object") ?? null;
    logCompetitionEnrichGuard({
      route: ROUTE_LISTINGS,
      listing_id:
        sampleRow?.external_listing_id != null
          ? String(sampleRow.external_listing_id)
          : sampleRow?.id != null
            ? String(sampleRow.id)
            : null,
      marketplace_account_id:
        sampleRow?.marketplace_account_id != null ? String(sampleRow.marketplace_account_id) : null,
      error_name: error.name,
      error_message: error.message,
      duration_ms: Date.now() - startedMs,
      stage: "competition_enrich_outer",
      grid_rows: gridRows.length,
    });
    applyCompetitionMetricsFallbackToAllGridRows(gridRows, "unavailable");
  }
}
