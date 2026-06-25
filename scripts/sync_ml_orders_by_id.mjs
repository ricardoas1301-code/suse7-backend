#!/usr/bin/env node
/**
 * Importa/re-sincroniza pedidos ML específicos (GET /orders/:id → persist).
 * Uso: node scripts/sync_ml_orders_by_id.mjs 2000016528508270 [outro_id...]
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fetchOrderById } from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { persistMercadoLibreOrder, rebuildListingSalesMetricsForUser } from "../src/handlers/ml/_helpers/mlSalesPersist.js";
import { enrichMlOrderBuyerThumbnailIfNeeded } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { enrichMercadoLivreSaleFinancialSnapshot } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import { ML_MARKETPLACE_SLUG } from "../src/handlers/ml/_helpers/mlMarketplace.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const orderIds = process.argv.slice(2).map((x) => String(x).trim()).filter(Boolean);
if (orderIds.length === 0) {
  console.error("Informe ao menos um external_order_id ML");
  process.exit(1);
}

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function resolveAccountForOrder(extOrderId) {
  const { data: existing } = await supabase
    .from("sales_orders")
    .select("user_id, marketplace_account_id, seller_company_id")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_order_id", extOrderId)
    .limit(1)
    .maybeSingle();

  if (existing?.user_id && existing?.marketplace_account_id) {
    return {
      userId: String(existing.user_id),
      marketplaceAccountId: String(existing.marketplace_account_id),
      sellerCompanyId: existing.seller_company_id != null ? String(existing.seller_company_id) : null,
      source: "sales_orders",
    };
  }

  const { data: accounts, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id, user_id, seller_company_id, external_seller_id, ml_nickname")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
  if (accErr) throw accErr;
  if (!accounts?.length) throw new Error("Nenhuma marketplace_accounts ativa para ML");

  for (const acc of accounts) {
    const userId = String(acc.user_id);
    const marketplaceAccountId = String(acc.id);
    try {
      const accessToken = await getValidMLToken(userId, { marketplaceAccountId });
      const order = await fetchOrderById(accessToken, extOrderId, { marketplaceAccountId });
      const sellerId = order?.seller?.id != null ? String(order.seller.id) : null;
      if (sellerId && String(acc.external_seller_id) === sellerId) {
        return {
          userId,
          marketplaceAccountId,
          sellerCompanyId: acc.seller_company_id != null ? String(acc.seller_company_id) : null,
          source: `account_match:${acc.ml_nickname || marketplaceAccountId}`,
        };
      }
    } catch {
      /* tenta próxima conta */
    }
  }

  if (accounts.length === 1) {
    const acc = accounts[0];
    return {
      userId: String(acc.user_id),
      marketplaceAccountId: String(acc.id),
      sellerCompanyId: acc.seller_company_id != null ? String(acc.seller_company_id) : null,
      source: "single_active_account",
    };
  }

  throw new Error(`Não foi possível resolver conta ML para o pedido ${extOrderId}`);
}

async function syncOne(extOrderId) {
  const ctx = await resolveAccountForOrder(extOrderId);
  const accessToken = await getValidMLToken(ctx.userId, { marketplaceAccountId: ctx.marketplaceAccountId });

  const detail = await fetchOrderById(accessToken, extOrderId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const shipping = detail?.shipping && typeof detail.shipping === "object" ? detail.shipping : null;
  const orderItems = Array.isArray(detail?.order_items) ? detail.order_items : [];

  console.log("[sync] ML order fetched", {
    external_order_id: extOrderId,
    status: detail?.status ?? null,
    shipping_status: shipping?.status ?? null,
    shipping_id: shipping?.id ?? null,
    order_items_count: orderItems.length,
    total_amount: detail?.total_amount ?? null,
    account_source: ctx.source,
  });

  const detailForPersist = await enrichMlOrderBuyerThumbnailIfNeeded(detail, accessToken, {
    marketplaceAccountId: ctx.marketplaceAccountId,
  });

  const out = await persistMercadoLibreOrder(supabase, ctx.userId, detailForPersist, {
    marketplace: ML_MARKETPLACE_SLUG,
    marketplaceAccountId: ctx.marketplaceAccountId,
    sellerCompanyId: ctx.sellerCompanyId,
    accessToken,
    log: (msg, extra) => console.log("[persist]", msg, extra ?? {}),
  });

  try {
    await enrichMercadoLivreSaleFinancialSnapshot(supabase, ctx.userId, detailForPersist, {
      accessToken,
      marketplaceAccountId: ctx.marketplaceAccountId,
      salesOrderId: out?.salesOrderId != null ? String(out.salesOrderId) : null,
      logContext: "sync_ml_orders_by_id",
    });
  } catch (e) {
    console.warn("[sync] financial_enrichment_warn", e instanceof Error ? e.message : String(e));
  }

  const { data: items, error: iErr } = await supabase
    .from("sales_order_items")
    .select("id, external_listing_id, title_snapshot, sku_snapshot, quantity, gross_amount, unit_price")
    .eq("sales_order_id", out.salesOrderId);
  if (iErr) throw iErr;

  console.log("[sync] OK", {
    external_order_id: extOrderId,
    sales_order_id: out.salesOrderId,
    items_count: items?.length ?? 0,
    items: items ?? [],
  });

  return { userId: ctx.userId, ...out, items };
}

async function main() {
  const usersToRebuild = new Set();
  const results = [];

  for (const oid of orderIds) {
    try {
      const r = await syncOne(oid);
      usersToRebuild.add(r.userId);
      results.push({ order_id: oid, ok: true, items: r.items?.length ?? 0 });
    } catch (e) {
      console.error("[sync] FAILED", oid, e instanceof Error ? e.message : String(e));
      const errMsg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e && "message" in e
            ? String(/** @type {{ message: unknown }} */ (e).message)
            : JSON.stringify(e);
      results.push({ order_id: oid, ok: false, error: errMsg });
    }
  }

  for (const userId of usersToRebuild) {
    const metrics = await rebuildListingSalesMetricsForUser(supabase, userId, ML_MARKETPLACE_SLUG, (m, x) =>
      console.log("[metrics]", m, x ?? {})
    );
    console.log("[metrics] rebuild", { userId, ...metrics });
  }

  console.log("\n=== RESUMO ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
