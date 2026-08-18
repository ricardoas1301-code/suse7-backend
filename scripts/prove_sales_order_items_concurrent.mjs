#!/usr/bin/env node
/**
 * Prova concorrente real — N persistências paralelas da mesma order ML.
 * Uso: node scripts/prove_sales_order_items_concurrent.mjs <external_order_id> [--runs 10]
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fetchOrderById } from "../src/handlers/ml/_helpers/mercadoLivreOrdersApi.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { persistMercadoLibreOrder } from "../src/handlers/ml/_helpers/mlSalesPersist.js";
import { enrichMlOrderBuyerThumbnailIfNeeded } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { ML_MARKETPLACE_SLUG } from "../src/handlers/ml/_helpers/mlMarketplace.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });

const extOrderId = process.argv[2];
const runs = Number(process.argv.find((a, i) => process.argv[i - 1] === "--runs") ?? 10);
if (!extOrderId) {
  console.error("Informe external_order_id");
  process.exit(1);
}

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function resolveAccountForOrder(orderId) {
  const { data: existing } = await supabase
    .from("sales_orders")
    .select("user_id, marketplace_account_id, seller_company_id")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_order_id", orderId)
    .limit(1)
    .maybeSingle();
  if (existing?.user_id && existing?.marketplace_account_id) {
    return {
      userId: String(existing.user_id),
      marketplaceAccountId: String(existing.marketplace_account_id),
      sellerCompanyId: existing.seller_company_id != null ? String(existing.seller_company_id) : null,
    };
  }
  throw new Error(`Conta não resolvida para order ${orderId}`);
}

async function persistOnce(runIndex) {
  const ctx = await resolveAccountForOrder(extOrderId);
  const accessToken = await getValidMLToken(ctx.userId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const detail = await fetchOrderById(accessToken, extOrderId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const detailForPersist = await enrichMlOrderBuyerThumbnailIfNeeded(detail, accessToken, {
    marketplaceAccountId: ctx.marketplaceAccountId,
  });
  const started = Date.now();
  const out = await persistMercadoLibreOrder(supabase, ctx.userId, detailForPersist, {
    marketplace: ML_MARKETPLACE_SLUG,
    marketplaceAccountId: ctx.marketplaceAccountId,
    sellerCompanyId: ctx.sellerCompanyId,
    accessToken,
    log: (msg, extra) => console.log(`[run ${runIndex}]`, msg, extra ?? {}),
  });
  return { runIndex, ms: Date.now() - started, salesOrderId: out?.salesOrderId, error: null };
}

async function main() {
  const ctx = await resolveAccountForOrder(extOrderId);
  const accessToken = await getValidMLToken(ctx.userId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const detail = await fetchOrderById(accessToken, extOrderId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const mlCount = Array.isArray(detail?.order_items) ? detail.order_items.length : 0;

  const startedAt = new Date().toISOString();
  const results = await Promise.all(
    Array.from({ length: runs }, (_, i) =>
      persistOnce(i + 1).catch((e) => ({
        runIndex: i + 1,
        ms: null,
        salesOrderId: null,
        error: e instanceof Error ? e.message : String(e),
      })),
    ),
  );

  const salesOrderId = results.find((r) => r.salesOrderId)?.salesOrderId;
  const { data: orders } = await supabase
    .from("sales_orders")
    .select("id")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_order_id", extOrderId);
  const { data: items, error: itemsErr } = salesOrderId
    ? await supabase
        .from("sales_order_items")
        .select("id, external_order_item_id, external_listing_id, quantity, gross_amount, created_at")
        .eq("sales_order_id", salesOrderId)
    : { data: [], error: null };
  if (itemsErr) throw itemsErr;

  const sumGross = (items ?? []).reduce((acc, r) => acc + Number(r.gross_amount ?? 0), 0);
  console.log(
    JSON.stringify(
      {
        ok: results.every((r) => !r.error),
        started_at_utc: startedAt,
        finished_at_utc: new Date().toISOString(),
        external_order_id: extOrderId,
        runs,
        ml_official_items: mlCount,
        sales_orders_count: orders?.length ?? 0,
        db_items_count: items?.length ?? 0,
        sum_gross_amount: sumGross,
        external_order_item_ids: [...new Set((items ?? []).map((r) => r.external_order_item_id).filter(Boolean))],
        items: items ?? [],
        run_results: results,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
