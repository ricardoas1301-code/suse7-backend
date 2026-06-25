#!/usr/bin/env node
/**
 * Emite os blocos [S7_HOMOLOG_MLB_CARD_DEBUG] para MLB4615133425 e MLB4222565497.
 * Uso: node scripts/homolog_mlb_card_debug.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { buildHistoricalCardOrderItemsAggregates } from "../src/domain/sales/historicalCardOrderItemsAggregates.js";
import { logHomologationMlbsCardDebug, HOMOLOG_MLB_DIGITS } from "../src/domain/sales/historicalCardHomologationDebug.js";
import { enrichListingGridRowsWithProductCardMetrics } from "../src/handlers/ml/_helpers/listingProductCardMetrics.js";
import { buildListingGridRow } from "../src/handlers/ml/_helpers/listingGridAssembler.js";
import {
  getListingGridRow,
  putListingGridRowAliases,
} from "../src/handlers/ml/_helpers/listingGridJoinKeys.js";
import { firstProductImageUrlFromJoin } from "../src/handlers/ml/_helpers/mercadoLibreListingCoverImage.js";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

process.env.S7_HOMOLOG_MLB_DEBUG = "1";

const DIGITS = HOMOLOG_MLB_DIGITS;

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!supabaseUrl || !serviceKey) {
  console.error("FAIL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes em .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** @type {unknown[]} */
const captured = [];

const origInfo = console.info;
console.info = (...args) => {
  const first = args[0];
  if (first === "[S7_HOMOLOG_MLB_CARD_DEBUG]" && args[1] && typeof args[1] === "object") {
    captured.push(args[1]);
  }
  origInfo.apply(console, args);
};

/**
 * @param {Record<string, unknown>} row
 */
function mapListingRow(row) {
  const { products: prodRel, marketplace_accounts: accRel, ...rest } = row;
  const accJoined = Array.isArray(accRel) && accRel[0] ? accRel[0] : accRel;
  const joinedAccountAlias =
    accJoined && typeof accJoined === "object"
      ? accJoined.account_alias != null && String(accJoined.account_alias).trim() !== ""
        ? String(accJoined.account_alias).trim()
        : accJoined.ml_nickname != null && String(accJoined.ml_nickname).trim() !== ""
          ? String(accJoined.ml_nickname).trim()
          : null
      : null;
  const pr =
    prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
      ? prodRel
      : Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
        ? prodRel[0]
        : null;
  return {
    ...rest,
    product_cover_url: firstProductImageUrlFromJoin(prodRel),
    product_cost_row:
      pr != null
        ? { cost_price: pr.cost_price, operational_cost: pr.operational_cost, packaging_cost: pr.packaging_cost }
        : null,
    product_name:
      pr?.product_name != null && String(pr.product_name).trim() !== "" ? String(pr.product_name).trim() : null,
    product_sku: pr?.sku != null && String(pr.sku).trim() !== "" ? String(pr.sku).trim() : null,
    joined_account_alias: joinedAccountAlias,
    products: prodRel,
  };
}

async function resolveUserIdForHomologMlbs() {
  const orFilter = DIGITS.map((d) => `external_listing_id.ilike.%${d}%`).join(",");
  const { data: hits, error } = await supabase
    .from("marketplace_listings")
    .select("user_id, external_listing_id")
    .or(orFilter)
    .limit(20);
  if (error) throw error;
  const userIds = [...new Set((hits || []).map((h) => String(h.user_id)).filter(Boolean))];
  if (userIds.length === 0) return { userId: null, hits: [] };
  return { userId: userIds[0], hits: hits || [], allUserIds: userIds };
}

async function main() {
  const { userId, hits, allUserIds } = await resolveUserIdForHomologMlbs();
  if (!userId) {
    console.error("FAIL: Nenhum marketplace_listings com MLB4615133425 ou MLB4222565497 encontrado no Supabase deste .env");
    process.exit(1);
  }

  origInfo("[homolog_mlb_card_debug] user_id=", userId, "users_with_hits=", allUserIds, "listing_hits=", hits);

  const LISTINGS_SELECT = `id, title, marketplace, marketplace_account_id, price, base_price, original_price, available_quantity, sold_quantity, status, external_listing_id, permalink, health, api_last_seen_at, currency_id, pictures_count, variations_count, seller_sku, seller_custom_field, listing_type_id, raw_json, product_id, financial_analysis_blocked, needs_attention, attention_reason, products(catalog_completeness, product_images, product_name, sku, cost_price, operational_cost, packaging_cost), marketplace_accounts(account_alias, ml_nickname, account_logo_url)`;

  let { data, error } = await supabase
    .from("marketplace_listings")
    .select(LISTINGS_SELECT)
    .eq("user_id", userId)
    .order("api_last_seen_at", { ascending: false });

  if (error) {
    const errMsg = String(error?.message ?? "").toLowerCase();
    if (errMsg.includes("marketplace_accounts")) {
      ({ data, error } = await supabase
        .from("marketplace_listings")
        .select(LISTINGS_SELECT.replace(", marketplace_accounts(account_alias, ml_nickname, account_logo_url)", ""))
        .eq("user_id", userId)
        .order("api_last_seen_at", { ascending: false }));
    }
  }
  if (error) throw error;

  const listings = (data ?? []).map(mapListingRow);

  const accountById = new Map();
  const { data: accountRows } = await supabase
    .from("marketplace_accounts")
    .select("id,account_alias,ml_nickname,account_logo_url")
    .eq("user_id", userId);
  for (const ar of accountRows || []) {
    const id = ar?.id != null ? String(ar.id).trim() : "";
    if (!id) continue;
    const alias =
      ar?.account_alias != null && String(ar.account_alias).trim() !== ""
        ? String(ar.account_alias).trim()
        : ar?.ml_nickname != null && String(ar.ml_nickname).trim() !== ""
          ? String(ar.ml_nickname).trim()
          : null;
    accountById.set(id, { alias, logoUrl: ar?.account_logo_url ?? null });
  }

  const { data: metricsRows } = await supabase
    .from("listing_sales_metrics")
    .select(
      "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, commission_amount_total, shipping_share_total, orders_count, last_sale_at"
    )
    .eq("user_id", userId);

  const metricsByKey = new Map();
  for (const m of metricsRows || []) {
    putListingGridRowAliases(metricsByKey, m.marketplace, m, (r) => r.external_listing_id);
  }

  const homologListings = listings.filter((l) =>
    DIGITS.some((d) => String(l.external_listing_id ?? "").includes(d))
  );

  const gridRows = homologListings.map((l) => {
    const met = getListingGridRow(metricsByKey, l.marketplace, l.external_listing_id);
    const row = buildListingGridRow(String(l.marketplace), l, met, null, null, { sellerTaxPct: null });
    const accountId =
      l.marketplace_account_id != null && String(l.marketplace_account_id).trim() !== ""
        ? String(l.marketplace_account_id).trim()
        : null;
    const accountMeta = accountId ? accountById.get(accountId) : null;
    row.marketplace_account_id = accountId;
    row.account_alias = accountMeta?.alias ?? l.joined_account_alias ?? null;
    row.ml_account_alias = row.account_alias;
    return row;
  });

  const orderItemsMaps = await buildHistoricalCardOrderItemsAggregates(
    supabase,
    userId,
    listings,
    accountById
  );

  enrichListingGridRowsWithProductCardMetrics(gridRows, {
    orderItemsMaps,
    metricsByKey,
    accountById,
  });

  await logHomologationMlbsCardDebug({
    supabase,
    userId,
    listings,
    gridRows,
    orderItems: orderItemsMaps?.orderItems ?? [],
    orderById: orderItemsMaps?.orderById ?? new Map(),
    accountById,
    orderItemsMaps,
    metricsByKey,
  });

  console.info("\n========== JSON BLOCOS PARA O RICO (copiar abaixo) ==========\n");
  for (const block of captured) {
    console.info(JSON.stringify(block, null, 2));
    console.info("");
  }
  if (captured.length < 2) {
    console.error(`WARN: Esperados 2 blocos, capturados ${captured.length}`);
    process.exit(captured.length === 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("FAIL:", e?.message ?? e);
  process.exit(1);
});
