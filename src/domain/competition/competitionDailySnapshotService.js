// ============================================================
// S7 — Concorrência: rotina diária automática de atualização
// Enriquece concorrentes ativos; grava snapshot só se houver mudança.
// ============================================================

import { DEFAULT_CURRENCY } from "./competitionNormalizer.js";
import {
  computeEnrichStatus,
  mergeNonemptyCompetitorPatch,
} from "./competitionEnrichHelpers.js";
import {
  findLatestSnapshotRowsForCompetitors,
  findOwnedProduct,
  findPrimaryListingForProduct,
  insertSnapshots,
  listActiveCompetitorsDueForDailyRefresh,
  countActiveCompetitorsDueForDailyRefresh,
  countActiveCompetitorsTotal,
  updateCompetitor,
} from "./competitionRepository.js";
import { enrichCompetitorForPersist } from "./competitionEnrichPersist.js";
import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import {
  buildSnapshotComparableBaseline,
  buildSnapshotComparableCandidate,
  detectRelevantSnapshotChanges,
  extractListingStatus,
} from "./competitionSnapshotDiff.js";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_TIMEBOX_MS = 52_000;

function resolveBatchSize(raw) {
  const env = Number(process.env.COMPETITION_DAILY_SNAPSHOT_BATCH_SIZE);
  const n = raw != null && String(raw).trim() !== "" ? Number(raw) : Number.isFinite(env) ? env : DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.trunc(n), 200);
}

function resolveMaxPerRun(raw) {
  const env = Number(process.env.COMPETITION_DAILY_SNAPSHOT_MAX_PER_RUN);
  const n = raw != null && String(raw).trim() !== "" ? Number(raw) : Number.isFinite(env) ? env : DEFAULT_MAX_PER_RUN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_PER_RUN;
  return Math.min(Math.trunc(n), 500);
}

function resolveTimeboxMs() {
  const env = Number(process.env.COMPETITION_DAILY_SNAPSHOT_TIMEBOX_MS);
  if (!Number.isFinite(env) || env < 5_000) return DEFAULT_TIMEBOX_MS;
  return Math.min(Math.trunc(env), 120_000);
}

/** Início do dia civil em America/Sao_Paulo (ISO com offset -03:00). */
export function resolveDailyRefreshCutoffIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}T00:00:00.000-03:00`;
}

function pickSalesHint(raw) {
  const v = raw?.sales_hint;
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : null;
}

function isActiveLimitError(err) {
  const msg = err?.message != null ? String(err.message).toLowerCase() : "";
  const code = err?.code != null ? String(err.code).trim() : "";
  return code === "23514" || msg.includes("limite de 9 concorrentes ativos");
}

function isCapturedOnOrAfterDayStart(capturedAt, dayStartIso) {
  if (!capturedAt || !dayStartIso) return false;
  const capturedMs = Date.parse(String(capturedAt));
  const dayStartMs = Date.parse(String(dayStartIso));
  if (!Number.isFinite(capturedMs) || !Number.isFinite(dayStartMs)) return false;
  return capturedMs >= dayStartMs;
}

function isVerifiedOnOrAfterDayStart(competitor, latestSnapshot, dayStartIso) {
  return (
    isCapturedOnOrAfterDayStart(competitor?.last_captured_at, dayStartIso) ||
    isCapturedOnOrAfterDayStart(latestSnapshot?.captured_at, dayStartIso)
  );
}

async function countPendingConsideringSnapshots(supabase, dayStartIso) {
  const rawDue = await listActiveCompetitorsDueForDailyRefresh(supabase, {
    dayStartIso,
    limit: 1000,
  });
  if (!rawDue.length) return 0;

  const byUser = new Map();
  for (const comp of rawDue) {
    const uid = String(comp.user_id ?? "");
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(comp.id);
  }

  const latestByCompetitorId = new Map();
  for (const [userId, ids] of byUser.entries()) {
    const latestMap = await findLatestSnapshotRowsForCompetitors(supabase, userId, ids);
    for (const [id, row] of latestMap.entries()) latestByCompetitorId.set(id, row);
  }

  let pending = 0;
  for (const comp of rawDue) {
    const latest = latestByCompetitorId.get(comp.id);
    if (!isVerifiedOnOrAfterDayStart(comp, latest, dayStartIso)) pending += 1;
  }
  return pending;
}

function extractOwnSellerId(listingRow) {
  const rawJson =
    listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  return rawJson?.seller_id != null && String(rawJson.seller_id).trim() !== ""
    ? String(rawJson.seller_id).trim()
    : null;
}

async function resolveAccessToken(tokenCache, userId, marketplaceAccountId) {
  const key = `${userId}:${marketplaceAccountId || "default"}`;
  if (tokenCache.has(key)) return tokenCache.get(key);
  try {
    const token = await getValidMLToken(userId, { marketplaceAccountId });
    tokenCache.set(key, token);
    return token;
  } catch (e) {
    console.warn("[competition-daily-snapshot] ml_token_unavailable", {
      user_id: userId,
      marketplace_account_id: marketplaceAccountId ?? null,
      message: e?.message ?? String(e),
    });
    tokenCache.set(key, null);
    return null;
  }
}

/**
 * Atualiza um concorrente ativo na rotina diária.
 * @returns {Promise<{
 *  status: "updated" | "unchanged" | "error" | "skipped",
 *  competitor_id: string | null,
 *  item_id: string | null,
 *  product_id: string | null,
 *  old_price: string | null,
 *  new_price: string | null,
 *  changed: boolean,
 *  captured_at: string,
 *  changed_fields?: string[],
 *  error_code?: string,
 *  error_message?: string,
 * }>}
 */
export async function refreshActiveCompetitorDaily({
  supabase,
  accessToken,
  competitor,
  latestSnapshot = null,
  capturedAt,
}) {
  const itemStartedAt = Date.now();
  const comp = competitor || {};
  const listingId = String(comp.competitor_listing_id || "").trim();
  const oldPrice = comp.last_seen_price != null ? String(comp.last_seen_price) : null;
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_START]", {
    competitor_id: comp.id ?? null,
    item_id: listingId || null,
    product_id: comp.product_id ?? null,
    old_price: oldPrice,
    last_captured_at: comp.last_captured_at ?? null,
  });
  if (!listingId) {
    return {
      status: "skipped",
      competitor_id: comp.id ?? null,
      item_id: null,
      product_id: comp.product_id ?? null,
      old_price: oldPrice,
      new_price: oldPrice,
      changed: false,
      captured_at: capturedAt,
      error_code: "missing_listing_id",
      error_message: "Concorrente sem competitor_listing_id",
    };
  }

  let normalized = {
    marketplace: comp.marketplace,
    competitor_listing_id: listingId,
    competitor_title: comp.competitor_title ?? null,
    competitor_seller_id: comp.competitor_seller_id ?? null,
    competitor_store_name: comp.competitor_store_name ?? null,
    competitor_permalink: comp.competitor_permalink ?? null,
    competitor_thumbnail: comp.competitor_thumbnail ?? null,
    last_seen_price: comp.last_seen_price ?? null,
    last_seen_currency: comp.last_seen_currency ?? DEFAULT_CURRENCY,
    source_strategy: comp.source_strategy ?? null,
  };

  let enrichExtras = {
    sales_hint: null,
    shipping: {},
    listing_type: null,
    reputation: {},
  };

  let enrichedRaw = null;

  try {
    const enrichStartedAt = Date.now();
    const enrichResult = await enrichCompetitorForPersist(accessToken, normalized, {
      sourceStrategy: comp.source_strategy ?? "ml_daily_refresh",
      forceFullEnrich: false,
      marketplace_account_id: comp.marketplace_account_id ?? null,
      skipSalesAudit: true,
      skipSalesResolver: true,
      fastDailyRefresh: true,
      initialExtras: {
        sales_hint: latestSnapshot?.sales_hint ?? null,
        shipping: latestSnapshot?.shipping ?? {},
        listing_type: latestSnapshot?.listing_type ?? null,
        reputation: latestSnapshot?.reputation ?? {},
      },
    });
    const enrichDurationMs = Date.now() - enrichStartedAt;
    normalized = enrichResult.normalized;
    enrichExtras = enrichResult.enrichExtras;
    enrichedRaw = enrichResult.enrichedRaw ?? null;
    console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_PHASES]", {
      competitor_id: comp.id ?? null,
      item_id: listingId || null,
      enrich_ms: enrichDurationMs,
    });
  } catch (e) {
    const errMsg = e?.message ?? String(e);
    console.warn("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_ERROR]", {
      competitor_id: comp.id,
      item_id: listingId,
      error_code: "enrich_failed",
      error_message: errMsg,
    });
    return {
      status: "error",
      competitor_id: comp.id ?? null,
      item_id: listingId,
      product_id: comp.product_id ?? null,
      old_price: oldPrice,
      new_price: oldPrice,
      changed: false,
      captured_at: capturedAt,
      error_code: "enrich_failed",
      error_message: errMsg,
    };
  }

  const baseline = buildSnapshotComparableBaseline({ competitor: comp, latestSnapshot });
  const candidate = buildSnapshotComparableCandidate({ normalized, enrichExtras, enrichedRaw });
  const diff = detectRelevantSnapshotChanges(baseline, candidate);

  const enrichPatch = {
    competitor_title: normalized.competitor_title,
    competitor_seller_id: normalized.competitor_seller_id,
    competitor_store_name: normalized.competitor_store_name,
    competitor_permalink: normalized.competitor_permalink,
    competitor_thumbnail: normalized.competitor_thumbnail,
    last_seen_price: normalized.last_seen_price,
    last_seen_currency: normalized.last_seen_currency,
  };

  const price = enrichPatch.last_seen_price != null ? enrichPatch.last_seen_price : null;
  const currency = enrichPatch.last_seen_currency || comp.last_seen_currency || DEFAULT_CURRENCY;
  const salesHint = pickSalesHint({ sales_hint: enrichExtras.sales_hint });
  const enrichMeta = computeEnrichStatus(normalized, enrichExtras);
  const listingStatus = normalized.competitor_listing_status ?? extractListingStatus(enrichedRaw);

  const touchPatch = mergeNonemptyCompetitorPatch(
    {},
    {
      ...enrichPatch,
      last_captured_at: capturedAt,
      ...(price != null ? { last_seen_price: price, last_seen_currency: currency } : {}),
      ...(listingStatus ? { competitor_listing_status: listingStatus } : {}),
    }
  );
  if (
    Object.prototype.hasOwnProperty.call(normalized, "competitor_listing_status") &&
    normalized.competitor_listing_status == null
  ) {
    touchPatch.competitor_listing_status = null;
  }

  if (!diff.changed) {
    try {
      const touchStartedAt = Date.now();
      await updateCompetitor(supabase, comp.user_id, comp.id, touchPatch);
      const touchDurationMs = Date.now() - touchStartedAt;
      console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_PHASES]", {
        competitor_id: comp.id ?? null,
        item_id: listingId,
        touch_ms: touchDurationMs,
      });
    } catch (e) {
      if (isActiveLimitError(e)) {
        const fallbackSnapshot = {
          user_id: comp.user_id,
          competitor_id: comp.id,
          marketplace: comp.marketplace,
          marketplace_account_id: comp.marketplace_account_id ?? null,
          seller_company_id: comp.seller_company_id ?? null,
          product_id: comp.product_id,
          sku: comp.sku ?? null,
          competitor_listing_id: listingId,
          competitor_title: enrichPatch.competitor_title ?? comp.competitor_title ?? null,
          competitor_price: price,
          currency,
          competitor_seller_id: enrichPatch.competitor_seller_id ?? comp.competitor_seller_id ?? null,
          competitor_store_name: enrichPatch.competitor_store_name ?? comp.competitor_store_name ?? null,
          competitor_permalink: enrichPatch.competitor_permalink ?? comp.competitor_permalink ?? null,
          competitor_thumbnail: enrichPatch.competitor_thumbnail ?? comp.competitor_thumbnail ?? null,
          shipping:
            enrichExtras.shipping && Object.keys(enrichExtras.shipping).length ? enrichExtras.shipping : null,
          listing_type: enrichExtras.listing_type ?? null,
          reputation:
            enrichExtras.reputation && Object.keys(enrichExtras.reputation).length
              ? enrichExtras.reputation
              : null,
          sales_hint: salesHint,
          source_strategy: comp.source_strategy ?? null,
          raw_snapshot: {
            context: "daily_auto_refresh_touch_fallback",
            touch_limit_blocked: true,
            changed_fields: [],
            listing_status: listingStatus,
          },
          captured_at: capturedAt,
        };
        await insertSnapshots(supabase, [fallbackSnapshot]);
        return {
          status: "unchanged",
          competitor_id: comp.id ?? null,
          item_id: listingId,
          product_id: comp.product_id ?? null,
          old_price: oldPrice,
          new_price: oldPrice,
          changed: false,
          captured_at: capturedAt,
        };
      }
      const errMsg = e?.message ?? String(e);
      console.warn("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_ERROR]", {
        competitor_id: comp.id,
        item_id: listingId,
        error_code: "touch_unchanged_failed",
        error_message: errMsg,
      });
      return {
        status: "error",
        competitor_id: comp.id ?? null,
        item_id: listingId,
        product_id: comp.product_id ?? null,
        old_price: oldPrice,
        new_price: oldPrice,
        changed: false,
        captured_at: capturedAt,
        error_code: "touch_unchanged_failed",
        error_message: errMsg,
      };
    }
    const newPriceUnchanged = touchPatch.last_seen_price != null ? String(touchPatch.last_seen_price) : oldPrice;
    console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_RESULT]", {
      competitor_id: comp.id ?? null,
      item_id: listingId,
      old_price: oldPrice,
      new_price: newPriceUnchanged,
      changed: false,
      status: "unchanged",
      captured_at: capturedAt,
      item_duration_ms: Date.now() - itemStartedAt,
    });
    return {
      status: "unchanged",
      competitor_id: comp.id ?? null,
      item_id: listingId,
      product_id: comp.product_id ?? null,
      old_price: oldPrice,
      new_price: newPriceUnchanged,
      changed: false,
      captured_at: capturedAt,
      item_duration_ms: Date.now() - itemStartedAt,
    };
  }

  const snapshotRow = {
    user_id: comp.user_id,
    competitor_id: comp.id,
    marketplace: comp.marketplace,
    marketplace_account_id: comp.marketplace_account_id ?? null,
    seller_company_id: comp.seller_company_id ?? null,
    product_id: comp.product_id,
    sku: comp.sku ?? null,
    competitor_listing_id: listingId,
    competitor_title: enrichPatch.competitor_title ?? comp.competitor_title ?? null,
    competitor_price: price,
    currency,
    competitor_seller_id: enrichPatch.competitor_seller_id ?? comp.competitor_seller_id ?? null,
    competitor_store_name: enrichPatch.competitor_store_name ?? comp.competitor_store_name ?? null,
    competitor_permalink: enrichPatch.competitor_permalink ?? comp.competitor_permalink ?? null,
    competitor_thumbnail: enrichPatch.competitor_thumbnail ?? comp.competitor_thumbnail ?? null,
    shipping:
      enrichExtras.shipping && Object.keys(enrichExtras.shipping).length ? enrichExtras.shipping : null,
    listing_type: enrichExtras.listing_type ?? null,
    reputation:
      enrichExtras.reputation && Object.keys(enrichExtras.reputation).length ? enrichExtras.reputation : null,
    sales_hint: salesHint,
    source_strategy: comp.source_strategy ?? null,
    raw_snapshot: {
      context: "daily_auto_refresh",
      enrich_status: enrichMeta.enrich_status,
      enrich_missing_fields: enrichMeta.enrich_missing_fields,
      changed_fields: diff.changed_fields,
      listing_status: listingStatus,
      category_id: enrichedRaw?.category_id ?? null,
      category_path: enrichedRaw?.category_path ?? null,
      competitor_pictures: Array.isArray(enrichExtras?.competitor_pictures)
        ? enrichExtras.competitor_pictures
        : null,
    },
    captured_at: capturedAt,
  };

  try {
    const snapshotStartedAt = Date.now();
    await insertSnapshots(supabase, [snapshotRow]);
    const snapshotDurationMs = Date.now() - snapshotStartedAt;
    try {
      const touchStartedAt = Date.now();
      await updateCompetitor(supabase, comp.user_id, comp.id, touchPatch);
      const touchDurationMs = Date.now() - touchStartedAt;
      console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_PHASES]", {
        competitor_id: comp.id ?? null,
        item_id: listingId,
        snapshot_ms: snapshotDurationMs,
        touch_ms: touchDurationMs,
      });
    } catch (e) {
      if (!isActiveLimitError(e)) throw e;
      console.warn("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_ERROR]", {
        competitor_id: comp.id,
        item_id: listingId,
        error_code: "touch_updated_blocked_by_active_limit",
        error_message: e?.message ?? String(e),
      });
    }
  } catch (e) {
    const errMsg = e?.message ?? String(e);
    console.warn("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_ERROR]", {
      competitor_id: comp.id,
      item_id: listingId,
      error_code: "persist_failed",
      error_message: errMsg,
    });
    return {
      status: "error",
      competitor_id: comp.id ?? null,
      item_id: listingId,
      product_id: comp.product_id ?? null,
      old_price: oldPrice,
      new_price: price != null ? String(price) : oldPrice,
      changed: true,
      captured_at: capturedAt,
      error_code: "persist_failed",
      error_message: errMsg,
    };
  }

  const newPriceUpdated = touchPatch.last_seen_price != null ? String(touchPatch.last_seen_price) : oldPrice;
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_RESULT]", {
    competitor_id: comp.id ?? null,
    item_id: listingId,
    old_price: oldPrice,
    new_price: newPriceUpdated,
    changed: true,
    status: "updated",
    captured_at: capturedAt,
    item_duration_ms: Date.now() - itemStartedAt,
  });

  return {
    status: "updated",
    competitor_id: comp.id ?? null,
    item_id: listingId,
    product_id: comp.product_id ?? null,
    old_price: oldPrice,
    new_price: newPriceUpdated,
    changed: true,
    captured_at: capturedAt,
    changed_fields: diff.changed_fields,
    item_duration_ms: Date.now() - itemStartedAt,
  };
}

/**
 * Processa um lote da rotina diária (todos os usuários, concorrentes ativos).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ limit?: number | string; maxPerRun?: number | string }} [opts]
 */
export async function runCompetitionDailySnapshotBatch(supabase, opts = {}) {
  const startedAt = Date.now();
  const timeboxMs = resolveTimeboxMs();
  const batchSize = resolveBatchSize(opts.limit);
  const maxPerRun = resolveMaxPerRun(opts.maxPerRun ?? opts.limit);
  const dayStartIso = resolveDailyRefreshCutoffIso();
  const capturedAt = new Date().toISOString();

  const summary = {
    ok: true,
    day_start_brt: dayStartIso,
    processed: 0,
    updated: 0,
    unchanged_touched: 0,
    unchanged: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    skipped_today: 0,
    total_eligible: 0,
    total_pending_today: 0,
    total_skipped_today: 0,
    remaining_estimate: 0,
    duration_ms: 0,
    timed_out: false,
    timezone: "America/Sao_Paulo",
    batch_size: batchSize,
    sample_results: [],
    item_duration_total_ms: 0,
    item_duration_avg_ms: 0,
    item_duration_max_ms: 0,
  };

  console.info("[S7_COMPETITION_DAILY_SNAPSHOT_START]", {
    started_at: new Date().toISOString(),
    timezone: summary.timezone,
    batch_size: batchSize,
  });
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT] started", {
    started_at: new Date().toISOString(),
    timezone: summary.timezone,
    batch_size: batchSize,
  });

  const tokenCache = new Map();
  const productCache = new Map();
  const listingCache = new Map();
  const snapshotCache = new Map();

  let processedThisRun = 0;

  const totalEligible = await countActiveCompetitorsTotal(supabase);
  const totalPendingTodayInitial = await countPendingConsideringSnapshots(supabase, dayStartIso);
  const totalSkippedTodayInitial = Math.max(0, totalEligible - totalPendingTodayInitial);
  summary.total_eligible = totalEligible;
  summary.total_pending_today = totalPendingTodayInitial;
  summary.total_skipped_today = totalSkippedTodayInitial;
  summary.skipped_today = totalSkippedTodayInitial;

  console.info("[S7_COMPETITION_DAILY_SNAPSHOT_ELIGIBLE]", {
    total_eligible: totalEligible,
    total_pending_today: totalPendingTodayInitial,
    total_skipped_today: totalSkippedTodayInitial,
  });

  while (processedThisRun < maxPerRun && Date.now() - startedAt < timeboxMs) {
    const remainingSlots = Math.min(batchSize, maxPerRun - processedThisRun);
    const dueCandidates = await listActiveCompetitorsDueForDailyRefresh(supabase, {
      dayStartIso,
      limit: Math.min(Math.max(remainingSlots * 10, remainingSlots), 1000),
    });

    if (dueCandidates.length === 0) break;

    const competitorIds = dueCandidates.map((c) => c.id).filter(Boolean);
    const missingSnapshotIds = competitorIds.filter((id) => !snapshotCache.has(id));
    if (missingSnapshotIds.length > 0) {
      const byUser = new Map();
      for (const comp of dueCandidates) {
        if (!missingSnapshotIds.includes(comp.id)) continue;
        const uid = String(comp.user_id);
        if (!byUser.has(uid)) byUser.set(uid, []);
        byUser.get(uid).push(comp.id);
      }
      for (const [userId, ids] of byUser.entries()) {
        const rows = await findLatestSnapshotRowsForCompetitors(supabase, userId, ids);
        for (const [id, row] of rows.entries()) snapshotCache.set(id, row);
        for (const id of ids) {
          if (!snapshotCache.has(id)) snapshotCache.set(id, null);
        }
      }
    }

    const competitors = dueCandidates
      .filter((comp) => {
        const latestSnapshot = snapshotCache.get(comp.id) ?? null;
        return !isVerifiedOnOrAfterDayStart(comp, latestSnapshot, dayStartIso);
      })
      .slice(0, remainingSlots);

    if (competitors.length === 0) break;

    for (const comp of competitors) {
      if (processedThisRun >= maxPerRun) break;
      if (Date.now() - startedAt >= timeboxMs) {
        summary.timed_out = true;
        break;
      }
      if (timeboxMs - (Date.now() - startedAt) < 6_000) {
        summary.timed_out = true;
        break;
      }

      processedThisRun += 1;
      summary.processed += 1;

      const accountId = comp.marketplace_account_id ?? null;
      const accessToken = await resolveAccessToken(tokenCache, comp.user_id, accountId);
      if (!accessToken) {
        summary.failed += 1;
        summary.errors = summary.failed;
        console.warn("[S7_COMPETITION_DAILY_SNAPSHOT_ITEM_ERROR]", {
          competitor_id: comp.id ?? null,
          item_id: comp.competitor_listing_id ?? null,
          error_code: "ml_token_unavailable",
          error_message: "Token do Mercado Livre indisponível para a conta.",
        });
        if (summary.sample_results.length < 10) {
          summary.sample_results.push({
            competitor_id: comp.id ?? null,
            item_id: comp.competitor_listing_id ?? null,
            product_id: comp.product_id ?? null,
            old_price: comp.last_seen_price != null ? String(comp.last_seen_price) : null,
            new_price: null,
            changed: false,
            status: "error",
            captured_at: capturedAt,
            error_code: "ml_token_unavailable",
            error_message: "Token do Mercado Livre indisponível para a conta.",
          });
        }
        continue;
      }

      const productKey = `${comp.user_id}:${comp.product_id}`;
      if (!productCache.has(productKey)) {
        try {
          productCache.set(productKey, await findOwnedProduct(supabase, comp.user_id, comp.product_id));
        } catch {
          productCache.set(productKey, null);
        }
      }

      if (!listingCache.has(productKey)) {
        try {
          listingCache.set(
            productKey,
            await findPrimaryListingForProduct(supabase, comp.user_id, comp.product_id)
          );
        } catch {
          listingCache.set(productKey, null);
        }
      }

      void productCache.get(productKey);
      void listingCache.get(productKey);

      const latestSnapshot = snapshotCache.get(comp.id) ?? null;
      const status = await refreshActiveCompetitorDaily({
        supabase,
        accessToken,
        competitor: comp,
        latestSnapshot,
        capturedAt,
      });

      const itemStatus = status?.status ?? "error";
      if (itemStatus === "updated") summary.updated += 1;
      else if (itemStatus === "unchanged") {
        summary.unchanged_touched += 1;
        summary.unchanged += 1;
      }
      else if (itemStatus === "skipped") summary.skipped += 1;
      else summary.failed += 1;
      summary.errors = summary.failed;
      if (summary.sample_results.length < 10) {
        summary.sample_results.push({
          competitor_id: status?.competitor_id ?? comp.id ?? null,
          item_id: status?.item_id ?? comp.competitor_listing_id ?? null,
          product_id: status?.product_id ?? comp.product_id ?? null,
          old_price: status?.old_price ?? (comp.last_seen_price != null ? String(comp.last_seen_price) : null),
          new_price: status?.new_price ?? null,
          changed: Boolean(status?.changed),
          status: itemStatus,
          captured_at: status?.captured_at ?? capturedAt,
          error_code: status?.error_code ?? null,
          error_message: status?.error_message ?? null,
          item_duration_ms: status?.item_duration_ms ?? null,
        });
      }
      if (Number.isFinite(Number(status?.item_duration_ms))) {
        const ms = Number(status.item_duration_ms);
        summary.item_duration_total_ms += ms;
        summary.item_duration_max_ms = Math.max(summary.item_duration_max_ms, ms);
      }

      if (
        status?.competitor_id &&
        status?.captured_at &&
        (itemStatus === "updated" || itemStatus === "unchanged")
      ) {
        const current = snapshotCache.get(status.competitor_id) ?? null;
        if (!current || Date.parse(String(status.captured_at)) >= Date.parse(String(current?.captured_at ?? 0))) {
          snapshotCache.set(status.competitor_id, {
            competitor_id: status.competitor_id,
            captured_at: status.captured_at,
          });
        }
      }
    }

    if (summary.timed_out) break;
    if (competitors.length < remainingSlots) break;
  }

  const remaining = await countPendingConsideringSnapshots(supabase, dayStartIso);
  summary.remaining_estimate = remaining;
  summary.total_pending_today = remaining;
  summary.total_skipped_today = Math.max(0, summary.total_eligible - remaining);
  summary.skipped_today = summary.total_skipped_today;
  summary.duration_ms = Date.now() - startedAt;
  if (summary.processed > 0) {
    summary.item_duration_avg_ms = Math.round(summary.item_duration_total_ms / summary.processed);
  }
  summary.errors = summary.failed;

  console.info("[S7_COMPETITION_DAILY_SNAPSHOT_END]", {
    processed: summary.processed,
    updated: summary.updated,
    unchanged_touched: summary.unchanged_touched,
    failed: summary.failed,
    remaining_estimate: summary.remaining_estimate,
    item_duration_avg_ms: summary.item_duration_avg_ms,
    item_duration_max_ms: summary.item_duration_max_ms,
  });
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT] processed", { value: summary.processed });
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT] changed", { value: summary.updated });
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT] unchanged_touched", { value: summary.unchanged_touched });
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT] errors", { value: summary.failed });
  console.info("[S7_COMPETITION_DAILY_SNAPSHOT] pending_after", { value: summary.remaining_estimate });
  return summary;
}
