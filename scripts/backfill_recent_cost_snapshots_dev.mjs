#!/usr/bin/env node
// =============================================================================
// Backfill focado — snapshots de custo ausentes em vendas recentes (DEV)
// - dry-run por padrão
// - apply via --apply
// - idempotente: só considera itens sem snapshots de custo
// =============================================================================

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { enrichMercadoLivreSaleFinancialSnapshot } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function parseArgs(argv) {
  const args = {
    apply: false,
    days: 7,
    limit: 500,
    sellerId: null,
    marketplaceAccountId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] ?? "").trim();
    if (a === "--apply") {
      args.apply = true;
      continue;
    }
    if (a === "--days" && argv[i + 1]) {
      args.days = Math.max(1, Math.trunc(Number(argv[i + 1]) || 7));
      i += 1;
      continue;
    }
    if (a === "--limit" && argv[i + 1]) {
      args.limit = Math.max(1, Math.min(5000, Math.trunc(Number(argv[i + 1]) || 500)));
      i += 1;
      continue;
    }
    if (a === "--seller-id" && argv[i + 1]) {
      args.sellerId = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
    if (a === "--marketplace-account-id" && argv[i + 1]) {
      args.marketplaceAccountId = String(argv[i + 1]).trim();
      i += 1;
      continue;
    }
  }
  return args;
}

function parseIsoDaysAgo(days) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function isMlMarketplace(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "mercado_livre" || s === "mercadolivre";
}

function pickFinancial(rawJson) {
  const raw = rawJson && typeof rawJson === "object" ? rawJson : null;
  const fin = raw?._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

function hasCostSnapshots(fin) {
  if (!fin || typeof fin !== "object") return false;
  const hasInternal = fin.internal_costs_snapshot && typeof fin.internal_costs_snapshot === "object";
  const hasProduct = fin.product_cost_snapshot && typeof fin.product_cost_snapshot === "object";
  const hasTax = fin.tax_snapshot && typeof fin.tax_snapshot === "object";
  const hasOperational =
    fin.operational_cost_snapshot && typeof fin.operational_cost_snapshot === "object";
  return Boolean(hasInternal && hasProduct && hasTax && hasOperational);
}

function summarizeItem(row) {
  const fin = pickFinancial(row?.raw_json);
  return {
    item_id: row?.id ?? null,
    sales_order_id: row?.sales_order_id ?? null,
    user_id: row?.user_id ?? null,
    marketplace: row?.marketplace ?? null,
    marketplace_account_id: row?.marketplace_account_id ?? null,
    external_order_id: row?.external_order_id ?? null,
    external_listing_id: row?.external_listing_id ?? null,
    created_at: row?.created_at ?? null,
    has_financial: Boolean(fin),
    snapshot_version: fin?.snapshot_version ?? null,
    has_cost_snapshots: hasCostSnapshots(fin),
  };
}

async function loadCandidateItems(sinceIso, limit, sellerId, marketplaceAccountId) {
  let q = supabase
    .from("sales_order_items")
    .select(
      "id,sales_order_id,user_id,marketplace,marketplace_account_id,external_order_id,external_listing_id,created_at,raw_json",
    )
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (sellerId) q = q.eq("user_id", sellerId);
  if (marketplaceAccountId) q = q.eq("marketplace_account_id", marketplaceAccountId);

  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadOrder(orderId, userId) {
  const { data, error } = await supabase
    .from("sales_orders")
    .select("id,user_id,marketplace_account_id,external_order_id,raw_json")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadOrderItems(orderId, userId) {
  const { data, error } = await supabase
    .from("sales_order_items")
    .select("id,raw_json")
    .eq("sales_order_id", orderId)
    .eq("user_id", userId);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const sinceIso = parseIsoDaysAgo(args.days);

  const scanned = await loadCandidateItems(
    sinceIso,
    args.limit,
    args.sellerId,
    args.marketplaceAccountId,
  );
  const mlRows = scanned.filter((r) => isMlMarketplace(r?.marketplace));
  const candidates = mlRows.filter((r) => {
    const fin = pickFinancial(r?.raw_json);
    if (!fin) return false;
    return !hasCostSnapshots(fin);
  });

  /** @type {Map<string, { order_id: string; user_id: string; marketplace_account_id: string | null; sample_external_order_id: string | null; items: string[] }>} */
  const ordersMap = new Map();
  for (const row of candidates) {
    const orderId = row?.sales_order_id != null ? String(row.sales_order_id).trim() : "";
    const userId = row?.user_id != null ? String(row.user_id).trim() : "";
    if (!orderId || !userId) continue;
    const key = `${userId}::${orderId}`;
    if (!ordersMap.has(key)) {
      ordersMap.set(key, {
        order_id: orderId,
        user_id: userId,
        marketplace_account_id:
          row?.marketplace_account_id != null ? String(row.marketplace_account_id) : null,
        sample_external_order_id:
          row?.external_order_id != null ? String(row.external_order_id) : null,
        items: [],
      });
    }
    ordersMap.get(key).items.push(String(row.id));
  }

  const orders = [...ordersMap.values()];
  const result = {
    mode: args.apply ? "apply" : "dry-run",
    since_iso: sinceIso,
    days: args.days,
    limit: args.limit,
    seller_id: args.sellerId,
    marketplace_account_id: args.marketplaceAccountId,
    scanned_items: scanned.length,
    scanned_ml_items: mlRows.length,
    candidate_items_missing_cost_snapshots: candidates.length,
    affected_orders: orders.length,
    fixed_orders: 0,
    fixed_items: 0,
    skipped_orders: 0,
    failed_orders: 0,
    samples: candidates.slice(0, 10).map(summarizeItem),
    failures: [],
  };

  if (!args.apply) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  /** @type {Map<string, string>} */
  const tokenCache = new Map();

  for (const orderRef of orders) {
    try {
      const order = await loadOrder(orderRef.order_id, orderRef.user_id);
      if (!order?.id || !order?.raw_json) {
        result.skipped_orders += 1;
        continue;
      }

      const accountId =
        order.marketplace_account_id != null
          ? String(order.marketplace_account_id).trim()
          : orderRef.marketplace_account_id != null
            ? String(orderRef.marketplace_account_id).trim()
            : "";
      if (!accountId) {
        result.skipped_orders += 1;
        continue;
      }

      const tokenKey = `${orderRef.user_id}::${accountId}`;
      let token = tokenCache.get(tokenKey) ?? null;
      if (!token) {
        token = await getValidMLToken(orderRef.user_id, { marketplaceAccountId: accountId });
        tokenCache.set(tokenKey, token);
      }

      const beforeItems = await loadOrderItems(orderRef.order_id, orderRef.user_id);
      const beforeMissing = beforeItems.filter((it) => !hasCostSnapshots(pickFinancial(it?.raw_json)));

      await enrichMercadoLivreSaleFinancialSnapshot(supabase, orderRef.user_id, order.raw_json, {
        accessToken: token,
        marketplaceAccountId: accountId,
        salesOrderId: orderRef.order_id,
        logContext: "backfill_recent_cost_snapshots",
        force: true,
        snapshotOrigin: "post_suse7_sale",
      });

      const afterItems = await loadOrderItems(orderRef.order_id, orderRef.user_id);
      const afterMissing = afterItems.filter((it) => !hasCostSnapshots(pickFinancial(it?.raw_json)));
      const fixed = Math.max(0, beforeMissing.length - afterMissing.length);
      if (fixed > 0) {
        result.fixed_orders += 1;
        result.fixed_items += fixed;
      } else {
        result.skipped_orders += 1;
      }
    } catch (err) {
      result.failed_orders += 1;
      result.failures.push({
        order_id: orderRef.order_id,
        user_id: orderRef.user_id,
        external_order_id: orderRef.sample_external_order_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

run().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});

