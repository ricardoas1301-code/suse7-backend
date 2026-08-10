// ======================================================================
// Polling incremental de vendas ML (últimas horas) — roda no servidor sem
// seller logado; complementa webhooks quando o cron chama o worker.
// Idempotência: applyMlOrderDetailToMarketplaceSales + persistMercadoLibreOrder.
// Retorno sempre estruturado (nunca null no JSON do job HTTP).
// ======================================================================

import { getValidMLToken } from "../../handlers/ml/_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";
import {
  fetchMercadoLibreUserMe,
  fetchOrderById,
  resolveMlOrdersSearchSort,
  searchSellerOrdersPage,
} from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { applyMlOrderDetailToMarketplaceSales } from "../../modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { advanceMlSalesWatermark } from "./mlSalesAccountWatermark.js";
import {
  buildMlConnectionUiPack,
  fetchMlTokenProbeForMlSeller,
  fetchMarketplaceAccountsWithActiveMlPipeline,
} from "./marketplaceAccountConnectionHealth.js";

const ORDER_TIMEOUT_MS = Math.min(
  180000,
  Math.max(5000, parseInt(process.env.ML_INITIAL_SALES_ORDER_PROCESS_TIMEOUT_MS || "45000", 10) || 45000)
);

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} fn
 */
async function mapLimit(items, concurrency, fn) {
  const out = [];
  let i = 0;
  /** @type {Promise<void>[]} */
  const workers = [];
  const run = async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      const it = items[idx];
      out[idx] = await fn(it);
    }
  };
  const c = Math.min(concurrency, Math.max(1, items.length || 1));
  for (let w = 0; w < c; w += 1) workers.push(run());
  await Promise.all(workers);
  return out;
}

function withTimeout(promise, ms, label) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resolveLookbackHours() {
  return Math.min(168, Math.max(2, parseInt(process.env.ML_INCREMENTAL_SALES_LOOKBACK_HOURS || "6", 10) || 6));
}

/** Sobreposição segura atrás do watermark confirmado (minutos). */
function resolveOverlapMinutes() {
  return Math.min(
    360,
    Math.max(15, parseInt(process.env.ML_INCREMENTAL_SALES_OVERLAP_MINUTES || "90", 10) || 90)
  );
}

/** Teto de catch-up após outagem (horas) — evita full historical acidental. */
function resolveMaxCatchupHours() {
  return Math.min(
    168,
    Math.max(12, parseInt(process.env.ML_INCREMENTAL_SALES_MAX_CATCHUP_HOURS || "120", 10) || 120)
  );
}

function resolveMaxPages() {
  return Math.min(20, Math.max(1, parseInt(process.env.ML_INCREMENTAL_SALES_MAX_PAGES || "4", 10) || 4));
}

function resolveDetailConcurrency() {
  return Math.min(
    8,
    Math.max(1, parseInt(process.env.ML_INCREMENTAL_SALES_DETAIL_CONCURRENCY || "3", 10) || 3)
  );
}

/**
 * Janela incremental oficial:
 * - baseline: now − lookback
 * - se houver watermark confirmado: estende até watermark − overlap (catch-up)
 * - nunca além de maxCatchup (sem full historical implícito)
 *
 * @param {{
 *   nowMs?: number;
 *   lookbackHours: number;
 *   overlapMinutes: number;
 *   maxCatchupHours: number;
 *   watermarkIso?: string | null;
 * }} args
 */
export function resolveIncrementalSalesWindow(args) {
  const nowMs = Number.isFinite(args.nowMs) ? /** @type {number} */ (args.nowMs) : Date.now();
  const lookbackHours = Math.max(1, Number(args.lookbackHours) || 6);
  const overlapMinutes = Math.max(0, Number(args.overlapMinutes) || 0);
  const maxCatchupHours = Math.max(lookbackHours, Number(args.maxCatchupHours) || lookbackHours);
  const rangeTo = new Date(nowMs).toISOString();
  const lookbackFromMs = nowMs - lookbackHours * 3600000;
  const maxCatchupFromMs = nowMs - maxCatchupHours * 3600000;
  let fromMs = lookbackFromMs;
  const wmRaw = args.watermarkIso != null ? String(args.watermarkIso).trim() : "";
  let desiredFromMs = lookbackFromMs;
  if (wmRaw) {
    const wmMs = Date.parse(wmRaw);
    if (Number.isFinite(wmMs)) {
      const withOverlapMs = wmMs - overlapMinutes * 60000;
      desiredFromMs = Math.min(fromMs, withOverlapMs);
      fromMs = desiredFromMs;
    }
  }
  const catchup_clamped = Boolean(wmRaw && Number.isFinite(desiredFromMs) && desiredFromMs < maxCatchupFromMs);
  const uncovered_through_ms = catchup_clamped ? maxCatchupFromMs : null;
  fromMs = Math.max(fromMs, maxCatchupFromMs);
  if (fromMs > nowMs) fromMs = lookbackFromMs;
  return {
    rangeFrom: new Date(fromMs).toISOString(),
    rangeTo,
    lookback_hours: lookbackHours,
    overlap_minutes: overlapMinutes,
    max_catchup_hours: maxCatchupHours,
    watermark_used: wmRaw || null,
    catchup_clamped,
    desired_from: catchup_clamped ? new Date(desiredFromMs).toISOString() : null,
    uncovered_through: catchup_clamped ? new Date(uncovered_through_ms).toISOString() : null,
  };
}

/**
 * Quando a outagem excede maxCatchupHours, divide [watermark−overlap → now] em chunks
 * explícitos (cada um ≤ maxCatchupHours) — evita descarte silencioso de período.
 *
 * @param {{
 *   nowMs?: number;
 *   lookbackHours: number;
 *   overlapMinutes: number;
 *   maxCatchupHours: number;
 *   watermarkIso?: string | null;
 * }} args
 */
export function resolveIncrementalSalesCatchupChunks(args) {
  const single = resolveIncrementalSalesWindow(args);
  if (!single.catchup_clamped || !single.watermark_used) {
    return { catchup_clamped: false, total_chunks: 1, chunks: [single] };
  }

  const nowMs = Number.isFinite(args.nowMs) ? /** @type {number} */ (args.nowMs) : Date.now();
  const overlapMinutes = Math.max(0, Number(args.overlapMinutes) || 0);
  const maxCatchupHours = Math.max(
    Number(args.lookbackHours) || 6,
    Number(args.maxCatchupHours) || 120
  );
  const wmMs = Date.parse(String(single.watermark_used));
  if (!Number.isFinite(wmMs)) {
    return { catchup_clamped: false, total_chunks: 1, chunks: [single] };
  }

  const gapStartMs = wmMs - overlapMinutes * 60000;
  const chunkMs = maxCatchupHours * 3600000;
  /** @type {typeof single[]} */
  const chunks = [];
  let cursor = gapStartMs;
  while (cursor < nowMs) {
    const chunkEndMs = Math.min(nowMs, cursor + chunkMs);
    chunks.push({
      ...single,
      rangeFrom: new Date(cursor).toISOString(),
      rangeTo: new Date(chunkEndMs).toISOString(),
      chunk_index: chunks.length,
      chunk_total: null,
      catchup_clamped: true,
    });
    if (chunkEndMs >= nowMs) break;
    cursor = chunkEndMs - overlapMinutes * 60000;
  }
  for (const c of chunks) c.chunk_total = chunks.length;
  return { catchup_clamped: true, total_chunks: chunks.length, chunks };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string[]} accountIds
 */
async function fetchActiveMlJobCountsByAccount(supabase, accountIds) {
  /** @type {Record<string, number>} */
  const map = {};
  const ids = accountIds.map((id) => String(id).trim()).filter(Boolean);
  if (!ids.length) return map;
  const { data, error } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("marketplace_account_id")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("marketplace_account_id", ids)
    .in("status", ["pending", "running"]);
  if (error) {
    console.warn("[sales-sync] incremental_active_job_count_query_error", { message: error.message });
    return map;
  }
  for (const row of data || []) {
    const id = String(row.marketplace_account_id || "");
    if (!id) continue;
    map[id] = (map[id] || 0) + 1;
  }
  return map;
}

/**
 * @param {string} skipReason
 * @param {{ accounts_attempted?: number; orders_fetched?: number; orders_persisted?: number; errors?: string[] }} [partial]
 */
function incrementalPollSkippedShape(skipReason, partial = {}) {
  return {
    attempted: false,
    skipped: true,
    skip_reason: skipReason,
    accounts_attempted: partial.accounts_attempted ?? 0,
    orders_fetched: partial.orders_fetched ?? 0,
    orders_persisted: partial.orders_persisted ?? 0,
    errors: Array.isArray(partial.errors) ? partial.errors : [],
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ deadlineMs?: number; maxAccounts?: number; pageLimit?: number }} [opts]
 */
export async function runIncrementalMlSalesPollWave(supabase, opts = {}) {
  if (process.env.ML_INCREMENTAL_SALES_POLL_ENABLE === "0") {
    const payload = incrementalPollSkippedShape("ML_INCREMENTAL_SALES_POLL_ENABLE=0");
    console.info("[sales-sync] incremental_poll_skipped", { skip_reason: payload.skip_reason });
    return payload;
  }

  const deadlineMs = opts.deadlineMs ?? Date.now() + 12000;
  const maxAccounts = Math.min(40, Math.max(1, Number(opts.maxAccounts) || 12));
  const pageLimit = Math.min(50, Math.max(10, Number(opts.pageLimit) || 50));
  const lookbackH = resolveLookbackHours();
  const overlapMin = resolveOverlapMinutes();
  const maxCatchupH = resolveMaxCatchupHours();
  const maxPages = resolveMaxPages();

  const selectVariants = [
    "id,user_id,seller_company_id,external_seller_id,status,ml_sales_last_sync_at,ml_sales_last_synced_order_created_to,token_expires_at",
    "id,user_id,seller_company_id,external_seller_id,status,ml_sales_last_sync_at,ml_sales_last_synced_order_created_to",
    "id,user_id,seller_company_id,external_seller_id,status,ml_sales_last_sync_at,token_expires_at",
    "id,user_id,seller_company_id,external_seller_id,status,ml_sales_last_sync_at",
    "id,user_id,seller_company_id,external_seller_id,status",
  ];

  /** @type {Record<string, unknown>[]} */
  let accounts = [];
  /** @type {string | null} */
  let accountsLoadError = null;
  for (const sel of selectVariants) {
    const { data, error } = await supabase
      .from("marketplace_accounts")
      .select(sel)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .eq("status", "active")
      .order("ml_sales_last_sync_at", { ascending: true, nullsFirst: true })
      .limit(maxAccounts);
    if (!error && Array.isArray(data)) {
      accounts = data;
      accountsLoadError = null;
      break;
    }
    if (error) accountsLoadError = error.message;
  }

  if (accounts.length === 0) {
    const skipReason = accountsLoadError
      ? `marketplace_accounts_query_failed:${accountsLoadError}`
      : "no_active_mercado_livre_accounts";
    const payload = incrementalPollSkippedShape(skipReason);
    console.info("[sales-sync] incremental_poll_skipped", {
      skip_reason: payload.skip_reason,
      max_accounts: maxAccounts,
    });
    return payload;
  }

  const accountIds = accounts.map((a) => (a?.id != null ? String(a.id).trim() : "")).filter(Boolean);

  const [activeByAcct, pipelineSet] = await Promise.all([
    fetchActiveMlJobCountsByAccount(supabase, accountIds),
    fetchMarketplaceAccountsWithActiveMlPipeline(supabase, accountIds, ML_MARKETPLACE_SLUG),
  ]);

  const out = {
    accounts_attempted: 0,
    orders_fetched: 0,
    orders_persisted: 0,
    errors: /** @type {string[]} */ ([]),
  };

  for (const acc of accounts) {
    if (Date.now() >= deadlineMs) break;
    const accountId = acc?.id != null ? String(acc.id).trim() : "";
    const userId = acc?.user_id != null ? String(acc.user_id).trim() : "";
    if (!accountId || !userId) continue;

    const extForProbe = acc?.external_seller_id != null ? String(acc.external_seller_id).trim() : "";
    const tokenProbe = extForProbe
      ? await fetchMlTokenProbeForMlSeller(supabase, userId, ML_MARKETPLACE_SLUG, extForProbe)
      : { present: false, expires_at: null, has_refresh: false };
    const pipelineActive = pipelineSet.has(accountId);
    const connectionPack = buildMlConnectionUiPack({ status: acc.status }, tokenProbe, pipelineActive);
    const salesAutoSyncEffective =
      connectionPack.connection_health === "connected" && String(acc?.status || "").toLowerCase() === "active";

    console.info("[sales-sync] incremental_poll_account_eval", {
      marketplace_account_id: accountId,
      user_id: userId,
      connection_health: connectionPack.connection_health,
      sales_auto_sync_effective: salesAutoSyncEffective,
      ml_token_expires_at: tokenProbe.expires_at,
      ml_token_present: tokenProbe.present,
      ml_has_refresh: tokenProbe.has_refresh,
      account_token_expires_at: acc.token_expires_at != null ? String(acc.token_expires_at) : null,
      active_chunks_pending_running: activeByAcct[accountId] ?? 0,
      pipeline_active: pipelineActive,
    });

    out.accounts_attempted += 1;
    const sellerCompanyId = acc.seller_company_id != null ? String(acc.seller_company_id) : null;

    let accessToken;
    try {
      accessToken = await getValidMLToken(userId, { marketplaceAccountId: accountId });
    } catch (e) {
      const em = e?.message ? String(e.message) : String(e);
      out.errors.push(`${accountId}:token:${em}`);
      console.warn("[sales-sync] account_error", {
        phase: "incremental_poll",
        marketplace: ML_MARKETPLACE_SLUG,
        marketplace_account_id: accountId,
        user_id: userId,
        connection_health: connectionPack.connection_health,
        error_message: em,
      });
      continue;
    }

    let sellerId = acc.external_seller_id != null ? String(acc.external_seller_id).trim() : "";
    try {
      const me = await fetchMercadoLibreUserMe(accessToken, { marketplaceAccountId: accountId });
      const meId = me?.id != null ? String(me.id).trim() : "";
      if (meId) sellerId = meId;
    } catch (e) {
      console.warn("[sales-sync] incremental_users_me_failed", {
        marketplace_account_id: accountId,
        message: e?.message,
      });
    }
    if (!sellerId) {
      out.errors.push(`${accountId}:no_seller_id`);
      continue;
    }

    const watermarkIso =
      acc.ml_sales_last_synced_order_created_to != null
        ? String(acc.ml_sales_last_synced_order_created_to)
        : acc.ml_sales_last_sync_at != null
          ? String(acc.ml_sales_last_sync_at)
          : null;
    const catchupPlan = resolveIncrementalSalesCatchupChunks({
      lookbackHours: lookbackH,
      overlapMinutes: overlapMin,
      maxCatchupHours: maxCatchupH,
      watermarkIso,
    });

    if (catchupPlan.catchup_clamped) {
      console.warn("[sales-sync] catchup_chunk_plan", {
        marketplace_account_id: accountId,
        total_chunks: catchupPlan.total_chunks,
        desired_from: catchupPlan.chunks[0]?.desired_from ?? null,
        uncovered_through: catchupPlan.chunks[0]?.uncovered_through ?? null,
        watermark: watermarkIso,
      });
    }

    /** @type {string | null} */
    let batchMaxCreated = null;
    let accountPersisted = 0;
    const summaryStub = {
      synced_count: 0,
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      skipped_cancelled_or_unavailable_count: 0,
      errors: /** @type {string[]} */ ([]),
    };
    const nowIso = new Date().toISOString();

    for (const window of catchupPlan.chunks) {
      if (Date.now() >= deadlineMs) break;
      const { rangeFrom, rangeTo } = window;

      console.info("[sales-sync] fetch_orders_start", {
        phase: "incremental_poll",
        marketplace: ML_MARKETPLACE_SLUG,
        marketplace_account_id: accountId,
        seller_company_id: sellerCompanyId,
        user_id: userId,
        external_seller_id: sellerId,
        window_start: rangeFrom,
        window_end: rangeTo,
        watermark: watermarkIso,
        lookback_hours: window.lookback_hours,
        overlap_minutes: window.overlap_minutes,
        max_catchup_hours: window.max_catchup_hours,
        catchup_clamped: window.catchup_clamped ?? false,
        chunk_index: window.chunk_index ?? null,
        chunk_total: window.chunk_total ?? null,
      });

      let offset = 0;
      /** @type {string | null} */
      let chunkMaxCreated = null;
      let chunkPersisted = 0;

      for (let page = 0; page < maxPages; page += 1) {
        if (Date.now() >= deadlineMs) break;
        const tPage = Date.now();
        let pg;
        try {
          pg = await searchSellerOrdersPage(accessToken, sellerId, offset, pageLimit, {
            dateFrom: rangeFrom,
            dateTo: rangeTo,
            marketplaceAccountId: accountId,
            sort: resolveMlOrdersSearchSort(),
          });
        } catch (e) {
          const em = e?.message ? String(e.message) : String(e);
          out.errors.push(`${accountId}:search:${em}`);
          console.warn("[sales-sync] account_error", {
            phase: "incremental_poll",
            marketplace_account_id: accountId,
            error_message: em,
          });
          break;
        }

        const orderIds = pg.orderIds || [];
        out.orders_fetched += orderIds.length;
        console.info("[sales-sync] fetch_orders_ok", {
          phase: "incremental_poll",
          marketplace_account_id: accountId,
          offset,
          batch_count: orderIds.length,
          duration_ms: Date.now() - tPage,
          chunk_index: window.chunk_index ?? null,
        });

        if (orderIds.length === 0) break;

        const detailConcurrency = resolveDetailConcurrency();
        const pairs = await mapLimit(orderIds, detailConcurrency, async (oid) => {
          try {
            const detail = await fetchOrderById(accessToken, oid, { marketplaceAccountId: accountId });
            return { oid, detail, err: null };
          } catch (e) {
            return { oid, detail: null, err: e };
          }
        });

        for (const pair of pairs) {
          if (Date.now() >= deadlineMs) break;
          if (pair.err || !pair.detail) continue;
          const detail = pair.detail;
          try {
          const result = await withTimeout(
            applyMlOrderDetailToMarketplaceSales(
              supabase,
              userId,
              accountId,
              sellerCompanyId,
              detail,
              nowIso,
              summaryStub,
              accessToken,
              { syncRunId: `incremental:${accountId}`, orderIndex: null, total: null, syncType: "ml_incremental_sales_poll" },
              { syncType: "ml_incremental_sales_poll" }
            ),
            ORDER_TIMEOUT_MS,
            "incremental_order"
          );
          if (result?.ok === false) {
            const reason = result?.reason ? String(result.reason) : "apply_failed";
            out.errors.push(`${pair.oid}:${reason}`);
            continue;
          }
          out.orders_persisted += 1;
            chunkPersisted += 1;
            accountPersisted += 1;
            console.info("[sales-sync] persist_order_ok", {
              phase: "incremental_poll",
              marketplace_account_id: accountId,
              external_order_id: String(pair.oid),
              chunk_index: window.chunk_index ?? null,
            });
            const created =
              detail?.date_created != null && String(detail.date_created).trim() !== ""
                ? String(detail.date_created)
                : null;
            if (created && (!chunkMaxCreated || Date.parse(created) > Date.parse(chunkMaxCreated))) {
              chunkMaxCreated = created;
            }
          } catch (e) {
            const em = e?.message ? String(e.message) : String(e);
            out.errors.push(`${pair.oid}:${em}`);
            console.warn("[sales-sync] account_error", {
              phase: "incremental_poll",
              marketplace_account_id: accountId,
              external_order_id: String(pair.oid),
              error_message: em,
            });
          }
        }

        if (orderIds.length < pageLimit) break;
        offset += pageLimit;
      }

      if (chunkMaxCreated || chunkPersisted > 0) {
        try {
          await advanceMlSalesWatermark(supabase, accountId, chunkMaxCreated, new Date().toISOString());
          if (chunkMaxCreated && (!batchMaxCreated || Date.parse(chunkMaxCreated) > Date.parse(batchMaxCreated))) {
            batchMaxCreated = chunkMaxCreated;
          }
        } catch (e) {
          console.warn("[sales-sync] incremental_watermark_warn", {
            marketplace_account_id: accountId,
            chunk_index: window.chunk_index ?? null,
            message: e?.message,
          });
        }
      }

      if (!catchupPlan.catchup_clamped) break;
    }

    console.info("[sales-sync] account_done", {
      phase: "incremental_poll",
      marketplace_account_id: accountId,
      account_orders_persisted: accountPersisted,
      orders_persisted_total: out.orders_persisted,
      catchup_chunks: catchupPlan.total_chunks,
      created_count: summaryStub.created_count,
      updated_count: summaryStub.updated_count,
    });
  }

  console.info("[sales-sync] incremental_wave_summary", {
    accounts_attempted: out.accounts_attempted,
    orders_fetched: out.orders_fetched,
    orders_persisted: out.orders_persisted,
    error_sample: out.errors.slice(0, 5),
  });

  return {
    attempted: true,
    skipped: false,
    skip_reason: null,
    accounts_attempted: out.accounts_attempted,
    orders_fetched: out.orders_fetched,
    orders_persisted: out.orders_persisted,
    errors: out.errors,
  };
}
