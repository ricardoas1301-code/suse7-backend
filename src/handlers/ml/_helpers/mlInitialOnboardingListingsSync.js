// ======================================================================
// Importação inicial de anúncios ML (onboarding / marketplace_account_sync_jobs).
// Reutiliza persistMercadoLibreListing como POST /api/ml/sync-listings (skipProductLink).
// ======================================================================

import { fetchMercadoLibreUserMe } from "./mercadoLibreOrdersApi.js";
import { fetchUserItemIdsPage, fetchItem, fetchItemDescription } from "./mercadoLibreItemsApi.js";
import { getValidMLToken } from "./mlToken.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { persistMercadoLibreListing } from "./mlListingsPersist.js";
import { rebuildListingSalesMetricsForUser } from "./mlSalesPersist.js";
import {
  ensureMarketplaceSyncJobRunning,
  patchMarketplaceSyncJob,
  completeMarketplaceSyncJob,
  failMarketplaceSyncJob,
} from "../../../services/marketplace/marketplaceSyncJobHelpers.js";

const PAGE_LIMIT = Math.min(
  100,
  Math.max(1, parseInt(process.env.ML_INITIAL_LISTINGS_SEARCH_LIMIT || "100", 10) || 100)
);

const ITEM_BATCH = Math.min(
  40,
  Math.max(2, parseInt(process.env.ML_INITIAL_LISTINGS_ITEM_BATCH || "10", 10) || 10)
);

const BATCH_CONCURRENCY = Math.min(
  12,
  Math.max(1, parseInt(process.env.ML_INITIAL_LISTINGS_BATCH_CONCURRENCY || "4", 10) || 4)
);

const MAX_ITEMS_CAP = Math.min(
  50000,
  Math.max(100, parseInt(process.env.ML_INITIAL_LISTINGS_MAX_ITEMS || "15000", 10) || 15000)
);

/** @param {string | null | undefined} raw */
function parseListingsCursor(raw) {
  try {
    const o = raw ? JSON.parse(raw) : {};
    const search_offset = Number.isFinite(Number(o.search_offset)) ? Number(o.search_offset) : 0;
    const idx_in_page = Number.isFinite(Number(o.idx_in_page)) ? Number(o.idx_in_page) : 0;
    const seller_id = o.seller_id != null ? String(o.seller_id).trim() : null;
    return { search_offset, idx_in_page, seller_id };
  } catch {
    return { search_offset: 0, idx_in_page: 0, seller_id: null };
  }
}

/** @param {{ search_offset: number; idx_in_page: number; seller_id: string | null }} c */
function serializeListingsCursor(c) {
  return JSON.stringify({
    search_offset: c.search_offset,
    idx_in_page: c.idx_in_page,
    seller_id: c.seller_id,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number }} runtime
 * @returns {Promise<{ stopped: boolean; done?: boolean }>}
 */
export async function runMlInitialListingsSyncJobTurn(supabase, job, runtime) {
  const { deadlineMs } = runtime;
  const accountId = String(job.marketplace_account_id || "");
  const userId = String(job.user_id || "");
  let jRow = await ensureMarketplaceSyncJobRunning(supabase, job);

  const { data: accountRow, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id,user_id,seller_company_id,external_seller_id,status")
    .eq("id", accountId)
    .maybeSingle();

  if (accErr) throw accErr;
  if (!accountRow?.id || String(accountRow.status || "").toLowerCase() !== "active") {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      "Conta marketplace inativa ou ausente.",
      "[ML_INITIAL_LISTINGS_SYNC_ERROR]"
    );
    return { stopped: true };
  }

  let accessToken;
  try {
    accessToken = await getValidMLToken(userId, { marketplaceAccountId: accountId });
  } catch (e) {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      e?.message ? String(e.message) : "token_ml",
      "[ML_INITIAL_LISTINGS_SYNC_ERROR]"
    );
    return { stopped: true };
  }

  let sellerId =
    accountRow.external_seller_id != null ? String(accountRow.external_seller_id).trim() : "";
  try {
    const me = await fetchMercadoLibreUserMe(accessToken);
    const meId = me?.id != null ? String(me.id).trim() : "";
    if (meId) sellerId = meId;
  } catch (e) {
    console.warn("[ML_INITIAL_LISTINGS_SYNC_BATCH] users_me_failed", { message: e?.message });
  }

  if (!sellerId) {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      "seller_id indisponível.",
      "[ML_INITIAL_LISTINGS_SYNC_ERROR]"
    );
    return { stopped: true };
  }

  let cursor = parseListingsCursor(
    jRow.last_cursor != null && typeof jRow.last_cursor === "string" ? jRow.last_cursor : null
  );
  cursor.seller_id = sellerId;

  let processedTotal = Number(jRow.progress_current ?? 0) || 0;
  let progressTotal = jRow.progress_total != null ? Number(jRow.progress_total) : null;

  const metaBase =
    typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
      ? /** @type {Record<string, unknown>} */ (jRow.metadata)
      : {};

  /** @type {string[]} */
  const errorsSample = Array.isArray(metaBase.errors_sample)
    ? /** @type {string[]} */ (metaBase.errors_sample.slice(-12))
    : [];

  console.info("[ML_INITIAL_LISTINGS_SYNC_START]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    cursor,
    processed_so_far: processedTotal,
  });

  /**
   * @param {string} itemId
   */
  async function processOneListing(itemId) {
    let syncStage = "fetch_item";
    try {
      const item = await fetchItem(accessToken, itemId);
      syncStage = "fetch_description";
      let description = null;
      try {
        description = await fetchItemDescription(accessToken, itemId);
      } catch (de) {
        console.warn("[ML_INITIAL_LISTINGS_SYNC_BATCH] description_skip", {
          itemId,
          reason: de?.message,
        });
      }
      syncStage = "persist";
      return await persistMercadoLibreListing(supabase, userId, item, description, {
        log: (m, x) =>
          console.log("[ml/initial-listings]", m, { itemId, ...(x && typeof x === "object" ? x : {}) }),
        accessToken,
        syncReason: "initial_onboarding",
        skipProductLink: true,
        marketplaceAccountId: accountId,
        sellerCompanyId:
          accountRow.seller_company_id != null ? String(accountRow.seller_company_id) : null,
      });
    } catch (err) {
      /** @type {Error & { syncStage?: string }} */
      const e = err instanceof Error ? err : new Error(String(err));
      e.syncStage = syncStage;
      throw e;
    }
  }

  while (Date.now() < deadlineMs) {
    if (processedTotal >= MAX_ITEMS_CAP) {
      await completeMarketplaceSyncJob(supabase, String(jRow.id), {
        progress_total: progressTotal ?? processedTotal,
        progress_current: processedTotal,
        last_cursor: null,
        last_synced_at: new Date().toISOString(),
        metadata: {
          ...metaBase,
          max_items_cap: MAX_ITEMS_CAP,
          errors_sample: errorsSample.slice(-12),
        },
      });
      console.info("[ML_INITIAL_LISTINGS_SYNC_DONE]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        processedTotal,
        capped: true,
      });
      return { stopped: true, done: true };
    }

    const page = await fetchUserItemIdsPage(accessToken, sellerId, cursor.search_offset, PAGE_LIMIT);
    const ids = (page.results || []).map((id) => String(id).trim()).filter(Boolean);

    if (progressTotal == null && page.paging?.total != null) {
      progressTotal = Number(page.paging.total);
    }

    console.info("[ML_INITIAL_LISTINGS_SYNC_BATCH]", {
      job_id: jRow.id,
      search_offset: cursor.search_offset,
      idx_in_page: cursor.idx_in_page,
      page_ids: ids.length,
      paging_total: page.paging?.total ?? null,
      processed_so_far: processedTotal,
    });

    if (ids.length === 0) {
      await completeMarketplaceSyncJob(supabase, String(jRow.id), {
        progress_total: progressTotal ?? processedTotal,
        progress_current: processedTotal,
        last_cursor: null,
        last_synced_at: new Date().toISOString(),
        metadata: { ...metaBase, errors_sample: errorsSample.slice(-12) },
      });
      console.info("[ML_INITIAL_LISTINGS_SYNC_DONE]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        processedTotal,
      });

      if (
        processedTotal > 0 &&
        process.env.ML_INITIAL_LISTINGS_SKIP_METRICS_REBUILD !== "1"
      ) {
        try {
          await rebuildListingSalesMetricsForUser(supabase, userId, ML_MARKETPLACE_SLUG, (m, x) =>
            console.log("[ml/initial-listings]", m, x)
          );
        } catch (me) {
          console.warn("[ML_INITIAL_LISTINGS_SYNC_BATCH] metrics_rebuild_warn", {
            message: me?.message,
            userId,
          });
        }
      }

      return { stopped: true, done: true };
    }

    if (cursor.idx_in_page >= ids.length) {
      cursor.search_offset += ids.length;
      cursor.idx_in_page = 0;
      await patchMarketplaceSyncJob(supabase, String(jRow.id), {
        last_cursor: serializeListingsCursor(cursor),
        progress_total: progressTotal,
        progress_current: processedTotal,
      });

      if (ids.length < PAGE_LIMIT) {
        await completeMarketplaceSyncJob(supabase, String(jRow.id), {
          progress_total: progressTotal ?? processedTotal,
          progress_current: processedTotal,
          last_cursor: null,
          last_synced_at: new Date().toISOString(),
          metadata: { ...metaBase, errors_sample: errorsSample.slice(-12) },
        });
        console.info("[ML_INITIAL_LISTINGS_SYNC_DONE]", {
          job_id: jRow.id,
          marketplace_account_id: accountId,
          processedTotal,
        });

        if (
          processedTotal > 0 &&
          process.env.ML_INITIAL_LISTINGS_SKIP_METRICS_REBUILD !== "1"
        ) {
          try {
            await rebuildListingSalesMetricsForUser(supabase, userId, ML_MARKETPLACE_SLUG, (m, x) =>
              console.log("[ml/initial-listings]", m, x)
            );
          } catch (me) {
            console.warn("[ML_INITIAL_LISTINGS_SYNC_BATCH] metrics_rebuild_warn", {
              message: me?.message,
              userId,
            });
          }
        }

        return { stopped: true, done: true };
      }
      continue;
    }

    const slice = ids.slice(cursor.idx_in_page, cursor.idx_in_page + ITEM_BATCH);
    const nowIso = new Date().toISOString();

    for (let si = 0; si < slice.length; si += BATCH_CONCURRENCY) {
      const sub = slice.slice(si, si + BATCH_CONCURRENCY);
      const results = await Promise.allSettled(sub.map((id) => processOneListing(id)));

      results.forEach((r, j) => {
        const itemId = sub[j];
        if (r.status === "fulfilled") {
          cursor.idx_in_page += 1;
          processedTotal += 1;
        } else {
          const msg = r.reason?.message || String(r.reason);
          const stage = r.reason?.syncStage || "unknown";
          console.error("[ML_INITIAL_LISTINGS_SYNC_ERROR]", {
            job_id: jRow.id,
            item_id: itemId,
            stage,
            msg,
          });
          errorsSample.push(`${itemId}:${stage}:${msg}`.slice(0, 400));
          cursor.idx_in_page += 1;
          processedTotal += 1;
        }
      });
    }

    let advancedPage = false;
    if (cursor.idx_in_page >= ids.length) {
      cursor.search_offset += ids.length;
      cursor.idx_in_page = 0;
      advancedPage = true;
      if (ids.length < PAGE_LIMIT) {
        await completeMarketplaceSyncJob(supabase, String(jRow.id), {
          progress_total: progressTotal ?? processedTotal,
          progress_current: processedTotal,
          last_cursor: null,
          last_synced_at: nowIso,
          metadata: { ...metaBase, errors_sample: errorsSample.slice(-12) },
        });
        console.info("[ML_INITIAL_LISTINGS_SYNC_DONE]", {
          job_id: jRow.id,
          marketplace_account_id: accountId,
          processedTotal,
        });

        if (
          processedTotal > 0 &&
          process.env.ML_INITIAL_LISTINGS_SKIP_METRICS_REBUILD !== "1"
        ) {
          try {
            await rebuildListingSalesMetricsForUser(supabase, userId, ML_MARKETPLACE_SLUG, (m, x) =>
              console.log("[ml/initial-listings]", m, x)
            );
          } catch (me) {
            console.warn("[ML_INITIAL_LISTINGS_SYNC_BATCH] metrics_rebuild_warn", {
              message: me?.message,
              userId,
            });
          }
        }

        return { stopped: true, done: true };
      }
    }

    await patchMarketplaceSyncJob(supabase, String(jRow.id), {
      last_cursor: serializeListingsCursor(cursor),
      progress_total: progressTotal,
      progress_current: processedTotal,
      last_synced_at: nowIso,
      metadata: {
        ...metaBase,
        last_batch_items: slice.length,
        advanced_page: advancedPage,
        errors_sample: errorsSample.slice(-12),
      },
    });

    jRow = {
      ...jRow,
      progress_total: progressTotal,
      progress_current: processedTotal,
      last_cursor: serializeListingsCursor(cursor),
      metadata: {
        ...metaBase,
        errors_sample: errorsSample.slice(-12),
      },
    };
  }

  return { stopped: false };
}
