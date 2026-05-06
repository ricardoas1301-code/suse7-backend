// ======================================================================
// Vínculo / criação de produtos no onboarding (ml_initial_products).
// Reutiliza batchEnsureProductsForListings (SKU literal + normalized_sku no helper).
// ======================================================================

import { ML_MARKETPLACE_SLUG, ML_MARKETPLACE_LISTING_ALIASES } from "./mlMarketplace.js";
import { extractSellerSku } from "./mlItemSkuExtract.js";
import { batchEnsureProductsForListings } from "./mlListingProductLink.js";
import {
  ensureMarketplaceSyncJobRunning,
  patchMarketplaceSyncJob,
  completeMarketplaceSyncJob,
  failMarketplaceSyncJob,
} from "../../../services/marketplace/marketplaceSyncJobHelpers.js";

const PAGE = Math.min(
  200,
  Math.max(15, parseInt(process.env.ML_INITIAL_PRODUCTS_PAGE_SIZE || "80", 10) || 80)
);

/** @param {string | null | undefined} raw */
function parseProductsCursor(raw) {
  try {
    const o = raw ? JSON.parse(raw) : {};
    const id_after =
      o.id_after != null && String(o.id_after).trim() !== "" ? String(o.id_after).trim() : null;
    return { id_after };
  } catch {
    return { id_after: null };
  }
}

/** @param {{ id_after: string | null }} c */
function serializeProductsCursor(c) {
  return JSON.stringify({ id_after: c.id_after });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} job
 * @param {{ deadlineMs: number }} runtime
 * @returns {Promise<{ stopped: boolean; done?: boolean }>}
 */
export async function runMlInitialProductsSyncJobTurn(supabase, job, runtime) {
  const { deadlineMs } = runtime;
  const accountId = String(job.marketplace_account_id || "");
  const userId = String(job.user_id || "");
  let jRow = await ensureMarketplaceSyncJobRunning(supabase, job);

  const { data: accountRow, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id,status,seller_company_id")
    .eq("id", accountId)
    .maybeSingle();

  if (accErr) throw accErr;
  if (!accountRow?.id || String(accountRow.status || "").toLowerCase() !== "active") {
    await failMarketplaceSyncJob(
      supabase,
      String(jRow.id),
      "Conta marketplace inativa ou ausente.",
      "[ML_INITIAL_PRODUCTS_SYNC_ERROR]"
    );
    return { stopped: true };
  }
  const sellerCompanyId =
    accountRow?.seller_company_id != null && String(accountRow.seller_company_id).trim() !== ""
      ? String(accountRow.seller_company_id).trim()
      : null;

  let cursor = parseProductsCursor(
    jRow.last_cursor != null && typeof jRow.last_cursor === "string" ? jRow.last_cursor : null
  );

  let scannedTotal = Number(jRow.progress_current ?? 0) || 0;
  let progressTotal = jRow.progress_total != null ? Number(jRow.progress_total) : null;

  const metaBase =
    typeof jRow.metadata === "object" && jRow.metadata && !Array.isArray(jRow.metadata)
      ? /** @type {Record<string, unknown>} */ (jRow.metadata)
      : {};

  let aggProductsCreated = Number(metaBase.products_created_total ?? 0) || 0;
  let aggLinkedExisting = Number(metaBase.listings_linked_existing_product_total ?? 0) || 0;
  let aggLinkedNew = Number(metaBase.listings_linked_new_product_total ?? 0) || 0;
  let aggSkippedNoSku = Number(metaBase.listings_skipped_no_sku_total ?? 0) || 0;
  let aggWarnings = Array.isArray(metaBase.warnings_sample)
    ? /** @type {string[]} */ (metaBase.warnings_sample.slice(-30))
    : [];

  function stepResult() {
    return {
      ok: true,
      step: "products",
      processed: scannedTotal,
      created: aggProductsCreated,
      updated: 0,
      linked: aggLinkedExisting + aggLinkedNew,
      without_sku: aggSkippedNoSku,
      warnings: aggWarnings.slice(-20),
    };
  }

  if (progressTotal == null) {
    const { count, error: cErr } = await supabase
      .from("marketplace_listings")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("marketplace_account_id", accountId)
      .eq("seller_company_id", sellerCompanyId)
      .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
      .is("product_id", null);
    if (cErr) {
      await failMarketplaceSyncJob(
        supabase,
        String(jRow.id),
        `count_listings: ${cErr.message}`,
        "[ML_INITIAL_PRODUCTS_SYNC_ERROR]"
      );
      return { stopped: true };
    }
    progressTotal = typeof count === "number" ? count : 0;

    await patchMarketplaceSyncJob(supabase, String(jRow.id), {
      progress_total: progressTotal,
      metadata: { ...metaBase, products_phase: "counted_pending_links" },
    });
    jRow.progress_total = progressTotal;
  }

  console.info("[ML_INITIAL_PRODUCTS_SYNC_START]", {
    job_id: jRow.id,
    marketplace_account_id: accountId,
    progress_total: progressTotal,
    progress_current: scannedTotal,
    cursor,
  });

  if (progressTotal === 0) {
    await completeMarketplaceSyncJob(supabase, String(jRow.id), {
      progress_total: 0,
      progress_current: 0,
      last_cursor: null,
      last_synced_at: new Date().toISOString(),
      metadata: {
        ...metaBase,
        note: "nenhum_anúncio_sem_produto_nesta_conta",
        step_result: stepResult(),
      },
    });
    console.info("[ML_INITIAL_PRODUCTS_SYNC_DONE]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      scannedTotal: 0,
    });
    return { stopped: true, done: true };
  }

  while (Date.now() < deadlineMs) {
    let q = supabase
      .from("marketplace_listings")
      .select("id, raw_json")
      .eq("user_id", userId)
      .eq("marketplace_account_id", accountId)
      .eq("seller_company_id", sellerCompanyId)
      .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
      .is("product_id", null)
      .order("id", { ascending: true })
      .limit(PAGE);

    if (cursor.id_after) {
      q = q.gt("id", cursor.id_after);
    }

    const { data: rows, error: qErr } = await q;

    if (qErr) {
      console.error("[ML_INITIAL_PRODUCTS_SYNC_ERROR]", {
        job_id: jRow.id,
        stage: "select_listings",
        message: qErr.message,
      });
      await failMarketplaceSyncJob(
        supabase,
        String(jRow.id),
        qErr.message ? String(qErr.message) : "select_listings",
        "[ML_INITIAL_PRODUCTS_SYNC_ERROR]"
      );
      return { stopped: true };
    }

    const list = rows ?? [];

    console.info("[ML_INITIAL_PRODUCTS_SYNC_BATCH]", {
      job_id: jRow.id,
      marketplace_account_id: accountId,
      page_size: list.length,
      id_after: cursor.id_after,
      scanned_so_far: scannedTotal,
      progress_total: progressTotal,
    });

    if (list.length === 0) {
      await completeMarketplaceSyncJob(supabase, String(jRow.id), {
        progress_total: progressTotal,
        progress_current: progressTotal,
        last_cursor: null,
        last_synced_at: new Date().toISOString(),
        metadata: {
          ...metaBase,
          products_created_total: aggProductsCreated,
          listings_linked_existing_product_total: aggLinkedExisting,
          listings_linked_new_product_total: aggLinkedNew,
          listings_skipped_no_sku_total: aggSkippedNoSku,
          warnings_sample: aggWarnings.slice(-30),
          step_result: stepResult(),
        },
      });
      console.info("[ML_INITIAL_PRODUCTS_SYNC_DONE]", {
        job_id: jRow.id,
        marketplace_account_id: accountId,
        scanned_total: progressTotal,
        products_created_total: aggProductsCreated,
        listings_linked_existing_product_total: aggLinkedExisting,
        listings_linked_new_product_total: aggLinkedNew,
        listings_skipped_no_sku_total: aggSkippedNoSku,
      });
      return { stopped: true, done: true };
    }

    /** @type {{ listingId: string; item: Record<string, unknown>; description: null }[]} */
    const entries = [];
    let pageSkippedNoSku = 0;

    for (const r of list) {
      const raw = r.raw_json;
      if (!raw || typeof raw !== "object") {
        pageSkippedNoSku += 1;
        aggWarnings.push(`listing:${String(r.id)}:raw_json_missing`);
        continue;
      }
      const item = /** @type {Record<string, unknown>} */ (raw);
      if (item.id == null) {
        pageSkippedNoSku += 1;
        aggWarnings.push(`listing:${String(r.id)}:external_item_id_missing`);
        continue;
      }
      if (!extractSellerSku(item)) {
        pageSkippedNoSku += 1;
        continue;
      }
      entries.push({
        listingId: String(r.id),
        item,
        description: null,
      });
    }

    let linkStats = null;
    if (entries.length > 0) {
      try {
        linkStats = await batchEnsureProductsForListings(supabase, userId, entries, {
          log: (m, x) => console.log("[ml/initial-products]", m, x || {}),
        });
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        console.error("[ML_INITIAL_PRODUCTS_SYNC_ERROR]", {
          job_id: jRow.id,
          stage: "batchEnsureProductsForListings",
          msg,
        });
        await failMarketplaceSyncJob(supabase, String(jRow.id), msg, "[ML_INITIAL_PRODUCTS_SYNC_ERROR]");
        return { stopped: true };
      }

      aggProductsCreated += linkStats.products_created ?? 0;
      aggLinkedExisting += linkStats.listings_linked_existing_product ?? 0;
      aggLinkedNew += linkStats.listings_linked_new_product ?? 0;
      aggSkippedNoSku += linkStats.listings_skipped_no_sku ?? 0;
    }

    aggSkippedNoSku += pageSkippedNoSku;

    scannedTotal += list.length;
    const progressCap = progressTotal != null ? progressTotal : scannedTotal;
    const progressDisplay = Math.min(scannedTotal, progressCap);

    const lastId = list[list.length - 1]?.id != null ? String(list[list.length - 1].id) : null;
    cursor = { id_after: lastId };

    const nowIso = new Date().toISOString();
    await patchMarketplaceSyncJob(supabase, String(jRow.id), {
      last_cursor: lastId ? serializeProductsCursor(cursor) : null,
      progress_total: progressTotal,
      progress_current: progressDisplay,
      last_synced_at: nowIso,
      metadata: {
        ...metaBase,
        products_created_total: aggProductsCreated,
        listings_linked_existing_product_total: aggLinkedExisting,
        listings_linked_new_product_total: aggLinkedNew,
        listings_skipped_no_sku_total: aggSkippedNoSku,
        warnings_sample: aggWarnings.slice(-30),
        step_result: stepResult(),
        last_batch_entries: entries.length,
        last_batch_rows: list.length,
      },
    });

    jRow.progress_current = progressDisplay;
    jRow.last_cursor = lastId ? serializeProductsCursor(cursor) : null;
  }

  return { stopped: false };
}
