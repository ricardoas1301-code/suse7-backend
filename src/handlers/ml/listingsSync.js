// ======================================================
// POST /api/ml/sync-listings
// - Importação: apenas anúncios NOVOS (ausentes em marketplace_listings) → persist completo + health.
// - Pós-scan: refresh de marketplace_listing_health para anúncios que JÁ existiam na base mas voltaram
//   na busca do ML (GET /items + enrich listing_prices + upsert health). Sem isso, new_count=0 deixaria
//   health.upsert_ok em 0 e taxas unitárias desatualizadas.
// Opt-out: body.skipHealthRefreshExisting ou ML_SYNC_SKIP_HEALTH_REFRESH_EXISTING=1.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG, ML_MARKETPLACE_LISTING_ALIASES } from "./_helpers/mlMarketplace.js";
import {
  fetchUserItemIdsPage,
  fetchItem,
  fetchItemDescription,
} from "./_helpers/mercadoLibreItemsApi.js";
import {
  persistMercadoLibreListing,
  patchMarketplaceListingScalarsFromMlItem,
} from "./_helpers/mlListingsPersist.js";
import {
  getHealthSyncMetrics,
  resetHealthSyncMetrics,
  upsertMarketplaceListingHealthFromMlItem,
} from "./_helpers/mlListingHealthPersist.js";
import { rebuildListingSalesMetricsForUser } from "./_helpers/mlSalesPersist.js";
import {
  batchEnsureProductsForListings,
  backfillListingProductLinksFromRawJson,
} from "./_helpers/mlListingProductLink.js";
import { extractSellerSku } from "./_helpers/mlItemSkuExtract.js";

const PAGE_LIMIT = 100;
const MAX_ITEMS = Math.min(10000, Math.max(1, parseInt(process.env.ML_SYNC_MAX_ITEMS || "3000", 10) || 3000));
const BATCH_CONCURRENCY = Math.min(
  12,
  Math.max(1, parseInt(process.env.ML_SYNC_BATCH_CONCURRENCY || "4", 10) || 4)
);

/**
 * IDs já importados para o usuário (Mercado Livre e aliases legados em marketplace_listings).
 * Evita re-fetch de itens já persistidos mesmo com valor divergente de marketplace.
 */
async function fetchExistingListingExternalIds(supabase, userId) {
  /** @type {Set<string>} */
  const set = new Set();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select("external_listing_id")
      .eq("user_id", userId)
      .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("[ml/sync-listings] existing_ids_query_failed", error);
      throw error;
    }
    if (!data?.length) break;

    for (const r of data) {
      if (r.external_listing_id != null && String(r.external_listing_id).trim() !== "") {
        set.add(String(r.external_listing_id).trim());
      }
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }
  return set;
}

export default async function handleMlListingsSync(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const userId = user.id;
  const logPrefix = "[ml/sync-listings]";
  const failures = [];

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    body = {};
  }
  const skipBackfill = body.skipBackfill === true;
  const debugProductLink =
    body.debug_product_link === true || process.env.ML_SYNC_RETURN_PRODUCT_TRACE === "1";
  /** Rastreio HTTP (substitui grep em logs do servidor quando debug_product_link=true). */
  const productLinkTrace = debugProductLink
    ? /** @type {{ at: string; event: string; [k: string]: unknown }[]} */ ([])
    : null;

  try {
    // ------------------------------
    // Vendedor ML (ml_user_id salvo no OAuth)
    // ------------------------------
    const { data: tokRow, error: tokErr } = await supabase
      .from("ml_tokens")
      .select("ml_user_id")
      .eq("user_id", userId)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .maybeSingle();

    if (tokErr || !tokRow?.ml_user_id) {
      console.error(logPrefix, "no_ml_tokens", { tokErr, userId });
      return res.status(400).json({
        ok: false,
        error:
          "Conta Mercado Livre não conectada. Conclua o OAuth em Perfil → Integrações antes de importar.",
      });
    }

    let accessToken;
    try {
      accessToken = await getValidMLToken(userId);
    } catch (e) {
      console.error(logPrefix, "token_error", { message: e?.message, userId });
      return res.status(401).json({
        ok: false,
        error: "Não foi possível obter token válido do Mercado Livre. Reconecte a integração.",
      });
    }

    const sellerId = String(tokRow.ml_user_id);
    console.log(logPrefix, "start", { userId, sellerId, maxItems: MAX_ITEMS, batch: BATCH_CONCURRENCY });

    resetHealthSyncMetrics();
    console.log("[ml/health] env", {
      ML_SYNC_SKIP_VISITS: process.env.ML_SYNC_SKIP_VISITS === "1",
      ML_SYNC_SKIP_PERFORMANCE: process.env.ML_SYNC_SKIP_PERFORMANCE === "1",
      ML_SYNC_HEALTH_LOG_SAMPLE: process.env.ML_SYNC_HEALTH_LOG_SAMPLE || "(default 5)",
      note:
        "Se ML_SYNC_SKIP_VISITS ou ML_SYNC_SKIP_PERFORMANCE estiverem em 1, visitas/performance não são buscadas; o upsert de health ainda grava fees/frete/promo/raw a partir do item.",
    });

    // ------------------------------
    // Coletar IDs (paginação até esgotar ou MAX_ITEMS)
    // ------------------------------
    const allIds = [];
    let offset = 0;

    while (allIds.length < MAX_ITEMS) {
      const page = await fetchUserItemIdsPage(accessToken, sellerId, offset, PAGE_LIMIT);
      const batch = page.results || [];
      if (batch.length === 0) break;

      for (const id of batch) {
        if (allIds.length >= MAX_ITEMS) break;
        allIds.push(String(id));
      }

      offset += batch.length;
      console.log(logPrefix, "search_page", { offset, collected: allIds.length, pageSize: batch.length });

      if (batch.length < PAGE_LIMIT) break;
    }

    console.log(logPrefix, "ids_ready", { total: allIds.length });

    const idsNormalized = [
      ...new Set(allIds.map((id) => String(id).trim()).filter((id) => id !== "")),
    ];
    const existingIds = await fetchExistingListingExternalIds(supabase, userId);
    const idsToImport = idsNormalized.filter((id) => !existingIds.has(id));
    const marketplaceTotal = idsNormalized.length;
    const alreadyExisting = marketplaceTotal - idsToImport.length;
    const newCount = idsToImport.length;

    console.log(logPrefix, "import_new_only", {
      marketplace_total: marketplaceTotal,
      already_existing: alreadyExisting,
      new_count: newCount,
      listings_ignored_existing: alreadyExisting,
    });

    const started = Date.now();
    let imported = 0;
    let importNewWithSellerSku = 0;
    let importNewWithoutSellerSku = 0;
    /** Vínculo produto só para anúncios COM SKU (import novo em lote). */
    let newImportProductsCreated = 0;
    let newImportListingsLinkedExisting = 0;
    let newImportListingsLinkedNew = 0;
    let newImportListingsSkippedNoSku = 0;
    /** Totais combinados (import com SKU + backfill) — compatível com resumos antigos. */
    let productsCreatedTotal = 0;
    let listingsLinkedExistingProduct = 0;
    let listingsLinkedNewProduct = 0;
    let listingsSkippedNoSkuTotal = 0;

    const logItem = (msg, extra) => console.log(logPrefix, msg, extra || {});

    if (productLinkTrace) {
      productLinkTrace.push({
        at: new Date().toISOString(),
        event: "sync_context",
        new_count: newCount,
        skip_backfill: skipBackfill,
        ids_to_import_len: idsToImport.length,
        marketplace_total: marketplaceTotal,
      });
    }

    /**
     * Por item: fetch → descrição (best-effort) → persist (sem vínculo produto; batch ao final do chunk).
     * Erros carregam `syncStage` para o resumo de falhas.
     */
    async function processOne(itemId) {
      let syncStage = "fetch_item";
      try {
        const item = await fetchItem(accessToken, itemId);

        syncStage = "fetch_description";
        let description = null;
        try {
          description = await fetchItemDescription(accessToken, itemId);
        } catch (de) {
          logItem("description_skip", { itemId, reason: de?.message, status: de?.status });
        }

        syncStage = "persist";
        return await persistMercadoLibreListing(supabase, userId, item, description, {
          log: (m, x) => logItem(m, { itemId, ...x }),
          accessToken,
          syncReason: "manual_import",
          skipProductLink: true,
          trace: productLinkTrace ?? undefined,
        });
      } catch (err) {
        err.syncStage = syncStage;
        throw err;
      }
    }

    // ------------------------------
    // Importação em lotes só dos IDs novos (controle de taxa / paralelismo)
    // ------------------------------
    for (let i = 0; i < idsToImport.length; i += BATCH_CONCURRENCY) {
      const chunk = idsToImport.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((id) => processOne(id)));

      /** @type {{ listingId: string; item: Record<string, unknown>; description: object | null }[]} */
      const forProductBatch = [];

      results.forEach((r, j) => {
        const itemId = chunk[j];
        if (r.status === "fulfilled") {
          imported += 1;
          const val = r.value;
          const item = val?.item && typeof val.item === "object"
            ? /** @type {Record<string, unknown>} */ (val.item)
            : null;
          if (item && extractSellerSku(item)) importNewWithSellerSku += 1;
          else if (item) importNewWithoutSellerSku += 1;

          if (val?.listingId && item && extractSellerSku(item)) {
            forProductBatch.push({
              listingId: String(val.listingId),
              item,
              description: val.description && typeof val.description === "object" ? val.description : null,
            });
          }
        } else {
          const reason = r.reason;
          const errMsg = reason?.message || String(reason);
          const stage = reason?.syncStage || "unknown";
          failures.push({ item_id: itemId, stage, error: errMsg });
          console.error(logPrefix, "item_failed", { itemId, stage, error: errMsg });
        }
      });

      if (forProductBatch.length > 0) {
        const linkStats = await batchEnsureProductsForListings(supabase, userId, forProductBatch, {
          log: (m, x) => logItem(m, x || {}),
          trace: productLinkTrace ?? undefined,
        });
        newImportProductsCreated += linkStats.products_created;
        newImportListingsLinkedExisting += linkStats.listings_linked_existing_product;
        newImportListingsLinkedNew += linkStats.listings_linked_new_product;
        newImportListingsSkippedNoSku += linkStats.listings_skipped_no_sku;
        productsCreatedTotal += linkStats.products_created;
        listingsLinkedExistingProduct += linkStats.listings_linked_existing_product;
        listingsLinkedNewProduct += linkStats.listings_linked_new_product;
        listingsSkippedNoSkuTotal += linkStats.listings_skipped_no_sku;
        if (linkStats.errors?.length) {
          logItem("batch_product_link_errors", { count: linkStats.errors.length, first: linkStats.errors[0] });
        }
      }
    }

    // ------------------------------
    // Health / taxas para anúncios já existentes (não passam pelo import de novos).
    // ------------------------------
    let healthExistingRefreshed = 0;
    let healthExistingFailed = 0;
    const skipHealthExisting =
      body.skipHealthRefreshExisting === true ||
      process.env.ML_SYNC_SKIP_HEALTH_REFRESH_EXISTING === "1";
    const idsAlreadyInDbOnMl = idsNormalized.filter((id) => existingIds.has(id));
    const maxHealthExisting = Math.max(
      0,
      parseInt(process.env.ML_SYNC_HEALTH_EXISTING_MAX ?? "10000", 10) || 10000
    );
    const idsForHealthOnly = idsAlreadyInDbOnMl.slice(0, maxHealthExisting);
    const healthExistingFullAux = process.env.ML_SYNC_HEALTH_EXISTING_FULL_AUX === "1";

    if (skipHealthExisting && idsAlreadyInDbOnMl.length > 0) {
      console.info("[ML_HEALTH_SYNC_EXISTING][skipped]", {
        reason: "skipHealthRefreshExisting ou ML_SYNC_SKIP_HEALTH_REFRESH_EXISTING",
        would_have_refreshed: Math.min(idsAlreadyInDbOnMl.length, maxHealthExisting),
      });
    } else if (!skipHealthExisting && idsForHealthOnly.length > 0) {
      console.info("[ML_HEALTH_SYNC_EXISTING][start]", {
        userId,
        sellerId,
        count_on_marketplace: idsAlreadyInDbOnMl.length,
        will_process: idsForHealthOnly.length,
        capped: idsAlreadyInDbOnMl.length > idsForHealthOnly.length,
        imported_new_this_run: imported,
        skip_auxiliary_api: !healthExistingFullAux,
        note: "visitas/performance omitidos por padrão neste lote; ML_SYNC_HEALTH_EXISTING_FULL_AUX=1 para buscar.",
      });

      async function processExistingHealth(itemId) {
        try {
          const item = await fetchItem(accessToken, itemId);
          const { data: listingRow } = await supabase
            .from("marketplace_listings")
            .select("id")
            .eq("user_id", userId)
            .eq("marketplace", ML_MARKETPLACE_SLUG)
            .eq("external_listing_id", String(itemId))
            .maybeSingle();
          const itemForHealth =
            listingRow?.id != null ? { ...item, _suse7_listing_uuid: String(listingRow.id) } : item;
          const healthOk = await upsertMarketplaceListingHealthFromMlItem(supabase, userId, itemForHealth, {
            log: (m, x) => logItem(m, { itemId, ...x }),
            accessToken,
            nowIso: new Date().toISOString(),
            marketplace: ML_MARKETPLACE_SLUG,
            healthSyncExistingPass: true,
            skipAuxiliaryApi: !healthExistingFullAux,
          });
          if (healthOk) {
            healthExistingRefreshed += 1;
            await patchMarketplaceListingScalarsFromMlItem(
              supabase,
              userId,
              ML_MARKETPLACE_SLUG,
              /** @type {Record<string, unknown>} */ (item),
              itemId
            );
          } else {
            healthExistingFailed += 1;
            failures.push({
              item_id: itemId,
              stage: "health_existing_refresh",
              error: "Falha ao mapear ou gravar marketplace_listing_health (ver [ml/health]).",
            });
          }
        } catch (err) {
          healthExistingFailed += 1;
          const errMsg = err?.message || String(err);
          failures.push({ item_id: itemId, stage: "health_existing_refresh", error: errMsg });
          console.error(logPrefix, "health_existing_failed", { itemId, error: errMsg });
        }
      }

      for (let i = 0; i < idsForHealthOnly.length; i += BATCH_CONCURRENCY) {
        const chunk = idsForHealthOnly.slice(i, i + BATCH_CONCURRENCY);
        await Promise.allSettled(chunk.map((id) => processExistingHealth(id)));
      }

      console.info("[ML_HEALTH_SYNC_EXISTING][batch_done]", {
        attempted: idsForHealthOnly.length,
        refreshed: healthExistingRefreshed,
        failed: healthExistingFailed,
      });
    } else if (!skipHealthExisting && idsAlreadyInDbOnMl.length === 0 && marketplaceTotal > 0) {
      console.info("[ML_HEALTH_SYNC_EXISTING][start]", {
        note: "nenhum ID retornado pelo ML já estava na base (conta nova ou base vazia vs catálogo)",
        userId,
        marketplace_total: marketplaceTotal,
      });
    }

    /** Pós-import: anúncios antigos com product_id NULL (ex.: código novo após migration). */
    let backfillStats = null;
    if (!skipBackfill) {
      try {
        logItem("product_link_backfill_start", { userId, skipBackfill: false });
        backfillStats = await backfillListingProductLinksFromRawJson(supabase, userId, {
          log: (m, x) => logItem(m, x || {}),
          trace: productLinkTrace ?? undefined,
        });
        if (backfillStats) {
          productsCreatedTotal += backfillStats.products_created ?? 0;
          listingsLinkedExistingProduct += backfillStats.listings_linked_existing_product ?? 0;
          listingsLinkedNewProduct += backfillStats.listings_linked_new_product ?? 0;
          listingsSkippedNoSkuTotal += backfillStats.listings_skipped_no_sku ?? 0;
        }
      } catch (bfErr) {
        console.error(logPrefix, "backfill_fatal", { message: bfErr?.message, userId });
      }
    } else {
      logItem("product_link_backfill_skipped", { userId });
    }

    const duration_ms = Date.now() - started;
    const healthMetrics = getHealthSyncMetrics();
    let listingsMetrics = null;
    if (
      imported > 0 &&
      process.env.ML_SYNC_SKIP_POST_LISTINGS_METRICS !== "1"
    ) {
      try {
        listingsMetrics = await rebuildListingSalesMetricsForUser(
          supabase,
          userId,
          ML_MARKETPLACE_SLUG,
          (m, x) => console.log(logPrefix, m, x)
        );
      } catch (me) {
        console.warn(logPrefix, "post_listings_metrics_rebuild_warn", { message: me?.message, userId });
      }
    }

    let message;
    if (newCount === 0) {
      message = skipBackfill
        ? "Não há anúncios novos para importar (backfill desligado)."
        : "Não há anúncios novos para importar; vínculos com produtos serão tentados a partir dos dados já salvos.";
    } else if (failures.length === 0 && imported === newCount) {
      message =
        imported === 1
          ? "1 anúncio importado com sucesso."
          : `${imported} anúncios importados com sucesso.`;
    } else if (imported > 0) {
      message = `${imported} anúncio(s) importado(s) com sucesso.`;
    } else {
      message = "Não foi possível importar os anúncios novos.";
    }

    console.log(logPrefix, "done", {
      marketplace_total: marketplaceTotal,
      already_existing: alreadyExisting,
      new_count: newCount,
      imported,
      import_new_with_seller_sku: importNewWithSellerSku,
      import_new_without_seller_sku: importNewWithoutSellerSku,
      new_import_product_link: {
        products_created: newImportProductsCreated,
        listings_linked_existing_product: newImportListingsLinkedExisting,
        listings_linked_new_product: newImportListingsLinkedNew,
        listings_skipped_no_sku: newImportListingsSkippedNoSku,
      },
      failed: failures.length,
      products_created: productsCreatedTotal,
      listings_linked_existing_product: listingsLinkedExistingProduct,
      listings_linked_new_product: listingsLinkedNewProduct,
      listings_skipped_no_sku: listingsSkippedNoSkuTotal,
      listings_update_applied_backfill: backfillStats?.listings_update_applied ?? null,
      backfill_loops: backfillStats?.loops ?? null,
      backfill_marked_sku_pending: backfillStats?.listings_marked_sku_pending ?? null,
      duration_ms,
      health: healthMetrics,
      health_existing_refresh: {
        skipped: skipHealthExisting,
        attempted: skipHealthExisting ? 0 : idsForHealthOnly.length,
        refreshed: healthExistingRefreshed,
        failed: healthExistingFailed,
      },
      listings_metrics: listingsMetrics,
    });

    const events = productLinkTrace ? new Set(productLinkTrace.map((x) => x.event)) : null;
    /** @type {string | undefined} */
    let debugScenario;
    if (debugProductLink && events) {
      if (!events.has("batch_start") && !events.has("backfill_start")) {
        debugScenario = "1_or_2_no_batch_and_no_backfill_in_trace (build antigo, ou fluxo não encheu trace)";
      } else if (events.has("batch_insert_failed")) {
        debugScenario = "3_batch_insert_products_failed";
      } else if (events.has("marketplace_listing_product_id_failed")) {
        debugScenario = "4_listing_product_id_update_failed";
      } else if (events.has("batch_skip_empty") && !events.has("batch_start")) {
        debugScenario = "2_batch_empty_entries_only";
      } else if (events.has("batch_no_prepared")) {
        debugScenario = "2b_batch_ran_zero_prepared_sku_missing_in_item_payload";
      } else if (events.has("batch_done")) {
        const done = productLinkTrace.filter((x) => x.event === "batch_done").pop();
        const created = Number(done?.products_created ?? 0);
        const applied = Number(done?.listings_update_applied ?? 0);
        debugScenario =
          created > 0 || applied > 0
            ? "batch_completed_with_inserts_or_links_check_supabase"
            : "batch_done_but_zero_products_and_zero_updates";
      } else if (events.has("backfill_start")) {
        debugScenario = "backfill_only_or_mixed_see_trace";
      } else {
        debugScenario = "unknown_see_debug_product_link_trace";
      }
    }

    return res.status(200).json({
      ok: true,
      message,
      summary: {
        marketplace_total: marketplaceTotal,
        already_existing: alreadyExisting,
        listings_ignored_existing: alreadyExisting,
        new_count: newCount,
        scanned: marketplaceTotal,
        imported,
        import_new_with_seller_sku: importNewWithSellerSku,
        import_new_without_seller_sku: importNewWithoutSellerSku,
        /** Criação/vínculo automático só para anúncios novos que trazem SKU do ML. */
        new_listings_product_link: {
          products_created: newImportProductsCreated,
          listings_linked_existing_product: newImportListingsLinkedExisting,
          listings_linked_new_product: newImportListingsLinkedNew,
          listings_skipped_no_sku: newImportListingsSkippedNoSku,
        },
        processed: imported,
        failed: failures.length,
        duration_ms,
        health: healthMetrics,
        listings_metrics_updated: listingsMetrics?.listingsUpdated ?? null,
        sales_backfill: listingsMetrics?.backfill ?? null,
        products_created: productsCreatedTotal,
        listings_linked_existing_product: listingsLinkedExistingProduct,
        listings_linked_new_product: listingsLinkedNewProduct,
        listings_skipped_no_sku: listingsSkippedNoSkuTotal,
        /** Backfill + marcação SKU pendente em anúncios antigos sem product_id. */
        backfill_product_links: backfillStats,
        skip_backfill: skipBackfill,
        health_existing_refresh: {
          skipped: skipHealthExisting,
          attempted: skipHealthExisting ? 0 : idsForHealthOnly.length,
          refreshed: healthExistingRefreshed,
          failed: healthExistingFailed,
        },
        ...(debugProductLink && productLinkTrace
          ? {
              debug_product_link_scenario: debugScenario,
            }
          : {}),
      },
      failures: failures.slice(0, 100),
      ...(debugProductLink && productLinkTrace
        ? { debug_product_link_trace: productLinkTrace, debug_product_link_scenario: debugScenario }
        : {}),
    });
  } catch (err) {
    console.error(logPrefix, "fatal", { message: err?.message, stack: err?.stack });
    return res.status(500).json({
      ok: false,
      error: err?.message || "Erro ao importar anúncios",
    });
  }
}
