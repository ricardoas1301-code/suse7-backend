// ======================================================
// POST /api/ml/sync-sales
// Busca pedidos do vendedor no ML, persiste pedido + itens + snapshot,
// recalcula listing_sales_metrics (derivado do banco, idempotente).
//
// Limites: ML_SYNC_MAX_ORDERS (default = teto abaixo), página 50.
// Preparado para ampliar offset/limit e janelas de data via env/query depois.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import {
  fetchMercadoLibreUserMe,
  searchSellerOrdersPage,
  fetchOrderById,
  nextOrdersSearchOffset,
} from "./_helpers/mercadoLibreOrdersApi.js";
import {
  persistMercadoLibreOrder,
  rebuildListingSalesMetricsForUser,
} from "./_helpers/mlSalesPersist.js";
import { createListingSnapshotsForUserMarketplace } from "./_helpers/listingSnapshots.js";

/** Máximo de pedidos por execução de POST /api/ml/sync-sales (teto e default). */
const MAX_ORDERS_CAP = 5000;

const PAGE_LIMIT = 50;
const MAX_ORDERS = Math.min(
  5000,
  Math.max(1, parseInt(process.env.ML_SYNC_MAX_ORDERS || "200", 10) || 200)
);
const BATCH_CONCURRENCY = Math.min(
  10,
  Math.max(1, parseInt(process.env.ML_SYNC_SALES_BATCH_CONCURRENCY || "4", 10) || 4)
);

/** Amostra de log por pedido (unit/gross/net). Defina ML_SALES_DEBUG_SAMPLE=5 no ambiente; default 0. */
const PRICING_DEBUG_ORDERS = Math.min(
  5,
  Math.max(0, parseInt(process.env.ML_SALES_DEBUG_SAMPLE || "0", 10) || 0)
);

export default async function handleMlSalesSync(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const userId = user.id;
  const logPrefix = "[ml/sync-sales]";
  const failures = [];

  try {
    // ------------------------------
    // Seller id (OAuth)
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
          "Conta Mercado Livre não conectada. Conclua o OAuth em Perfil → Integrações antes de sincronizar vendas.",
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

    const mlUserIdFromDb = String(tokRow.ml_user_id).trim();

    let sellerId = mlUserIdFromDb;
    try {
      const me = await fetchMercadoLibreUserMe(accessToken);
      const meId = me?.id != null ? String(me.id).trim() : null;
      if (meId) {
        if (meId !== mlUserIdFromDb) {
          console.warn(logPrefix, "seller_id_mismatch_using_users_me", {
            ml_tokens_ml_user_id: mlUserIdFromDb,
            users_me_id: meId,
            nickname: me?.nickname,
          });
          const { error: fixErr } = await supabase
            .from("ml_tokens")
            .update({ ml_user_id: meId, updated_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("marketplace", ML_MARKETPLACE_SLUG);
          if (fixErr) {
            console.error(logPrefix, "failed_to_persist_me_id", fixErr);
          }
        }
        sellerId = meId;
      }
    } catch (meErr) {
      console.error(logPrefix, "users_me_failed_fallback_db_ml_user_id", {
        message: meErr?.message,
        mlUserIdFromDb,
      });
    }

    console.log(logPrefix, "start", {
      userId,
      sellerId,
      ml_user_id_from_db: mlUserIdFromDb,
      maxOrders: MAX_ORDERS,
      batch: BATCH_CONCURRENCY,
    });

    // ------------------------------
    // IDs de pedidos (paginação /orders/search)
    // ------------------------------
    const allIds = [];
    let offset = 0;
    let marketplaceTotalHint = null;

    while (allIds.length < MAX_ORDERS) {
      const page = await searchSellerOrdersPage(accessToken, sellerId, offset, PAGE_LIMIT);
      if (marketplaceTotalHint == null && page.paging?.total != null) {
        marketplaceTotalHint = Number(page.paging.total);
      }

      const batch = page.orderIds || [];
      if (batch.length === 0) break;

      for (const oid of batch) {
        if (allIds.length >= MAX_ORDERS) break;
        allIds.push(oid);
      }

      const prevOffset = offset;
      offset = nextOrdersSearchOffset(offset, PAGE_LIMIT, batch.length);
      console.log(logPrefix, "search_page", {
        offset_prev: prevOffset,
        offset_next: offset,
        collected: allIds.length,
        pageSize: batch.length,
        paging_total: page.paging?.total,
      });

      if (batch.length < PAGE_LIMIT) break;
    }

    const scanned = allIds.length;
    console.log(logPrefix, "order_ids_ready", { scanned, marketplaceTotalHint });

    const started = Date.now();
    let processed = 0;

    const pricingDebug = PRICING_DEBUG_ORDERS > 0 ? { remaining: PRICING_DEBUG_ORDERS } : null;

    /**
     * Um pedido: GET /orders/:id → persistência isolada (falha não aborta os outros).
     */
    async function processOneOrder(orderId) {
      let syncStage = "fetch_order";
      try {
        const detail = await fetchOrderById(accessToken, orderId);
        syncStage = "persist_order";
        await persistMercadoLibreOrder(supabase, userId, detail, {
          marketplace: ML_MARKETPLACE_SLUG,
          log: (msg, extra) => console.log(logPrefix, msg, { orderId, ...extra }),
          pricingDebug: pricingDebug || undefined,
        });
      } catch (err) {
        err.syncStage = syncStage;
        throw err;
      }
    }

    for (let i = 0; i < allIds.length; i += BATCH_CONCURRENCY) {
      const chunk = allIds.slice(i, i + BATCH_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((id) => processOneOrder(id)));

      results.forEach((r, j) => {
        const external_order_id = chunk[j];
        if (r.status === "fulfilled") {
          processed += 1;
        } else {
          const reason = r.reason;
          const stage = reason?.syncStage || "unknown";
          const error = reason?.message || String(reason);
          failures.push({ external_order_id, stage, error });
          console.error(logPrefix, "order_failed", { external_order_id, stage, error });
        }
      });
    }

    // ------------------------------
    // Consolidado por anúncio (rebuild completo user+marketplace)
    // ------------------------------
    let metricsInfo = { listingsUpdated: 0 };
    try {
      metricsInfo = await rebuildListingSalesMetricsForUser(
        supabase,
        userId,
        ML_MARKETPLACE_SLUG,
        (m, x) => console.log(logPrefix, m, x)
      );
    } catch (me) {
      console.error(logPrefix, "metrics_rebuild_failed", { message: me?.message, userId });
      return res.status(500).json({
        ok: false,
        error: "Pedidos importados parcialmente, mas falhou o recálculo das métricas por anúncio.",
        partial: {
          scanned,
          processed,
          failed: failures.length,
          failures: failures.slice(0, 50),
        },
      });
    }
    await createListingSnapshotsForUserMarketplace(supabase, {
      userId,
      marketplace: ML_MARKETPLACE_SLUG,
      capturedAt: new Date().toISOString(),
    });

    const duration_ms = Date.now() - started;
    console.log(logPrefix, "done", {
      scanned,
      processed,
      failed: failures.length,
      listingsUpdated: metricsInfo.listingsUpdated,
      duration_ms,
    });

    return res.status(200).json({
      ok: true,
      summary: {
        scanned,
        processed,
        failed: failures.length,
        /** Limite efetivo nesta execução (env ML_SYNC_MAX_ORDERS ou default). */
        max_orders_limit: MAX_ORDERS,
        marketplace_total_orders_hint: marketplaceTotalHint,
        listings_metrics_updated: metricsInfo.listingsUpdated,
        sales_order_items_backfill: metricsInfo.backfill ?? null,
        duration_ms,
      },
      diagnostic:
        scanned === 0
          ? {
              seller_id_used: sellerId,
              ml_user_id_from_db: mlUserIdFromDb,
              paging_total_from_api: marketplaceTotalHint,
              hints: [
                "Confira logs [ml/orders]: http_status, total_results_hint, orders_returned.",
                "Defina ML_ORDERS_LOG_RAW=1 para body completo da API (uma página).",
                "Se scope antigo não incluía read: reconecte OAuth (Perfil → Integrações) após deploy com escopos explícitos.",
                "Se sort quebrar no seu site: ML_ORDERS_SEARCH_NO_SORT=1.",
              ],
            }
          : undefined,
      failures: failures.slice(0, 100),
    });
  } catch (err) {
    console.error(logPrefix, "fatal", { message: err?.message, stack: err?.stack });
    return res.status(500).json({
      ok: false,
      error: err?.message || "Erro ao sincronizar vendas",
    });
  }
}
