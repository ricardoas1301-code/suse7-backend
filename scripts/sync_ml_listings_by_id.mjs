#!/usr/bin/env node
/**
 * Re-sincroniza anúncios ML específicos (GET /items/:id → persist + health).
 * Uso: node scripts/sync_ml_listings_by_id.mjs MLB6086602390 [outro_mlb...]
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fetchItem, fetchItemDescription, enrichItemWithListingPricesFees } from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { persistMercadoLibreListing } from "../src/handlers/ml/_helpers/mlListingsPersist.js";
import { ML_MARKETPLACE_SLUG } from "../src/handlers/ml/_helpers/mlMarketplace.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const listingIds = process.argv.slice(2).map((x) => String(x).trim()).filter(Boolean);
if (listingIds.length === 0) {
  console.error("Informe ao menos um external_listing_id ML (ex.: MLB6086602390)");
  process.exit(1);
}

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

/**
 * @param {string} raw
 */
function externalListingIdVariants(raw) {
  const ext = String(raw ?? "").trim();
  if (!ext) return [];
  const upper = ext.toUpperCase();
  const noPrefix = upper.replace(/^MLB/i, "");
  const withPrefix = noPrefix !== "" ? `MLB${noPrefix}` : upper;
  return [...new Set([ext, upper, noPrefix, withPrefix].filter((v) => v !== ""))];
}

/**
 * @param {string} extListingId
 */
async function resolveAccountForListing(extListingId) {
  const variants = externalListingIdVariants(extListingId);

  const { data: row, error: rowErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id, external_listing_id, marketplace_account_id, seller_company_id, title, status")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("external_listing_id", variants.length ? variants : [extListingId])
    .limit(1)
    .maybeSingle();

  if (rowErr) throw rowErr;

  if (row?.user_id) {
    return {
      userId: String(row.user_id),
      marketplaceAccountId:
        row.marketplace_account_id != null ? String(row.marketplace_account_id) : null,
      sellerCompanyId: row.seller_company_id != null ? String(row.seller_company_id) : null,
      listingRowId: row.id != null ? String(row.id) : null,
      externalListingId: row.external_listing_id != null ? String(row.external_listing_id) : extListingId,
      source: "marketplace_listings",
      title: row.title ?? null,
    };
  }

  const { data: accounts, error: accErr } = await supabase
    .from("marketplace_accounts")
    .select("id, user_id, seller_company_id, external_seller_id, ml_nickname, status")
    .eq("marketplace", ML_MARKETPLACE_SLUG);
  if (accErr) throw accErr;
  if (!accounts?.length) throw new Error("Nenhuma marketplace_accounts para ML");

  const activeAccounts = accounts.filter((a) => String(a.status || "").toLowerCase() === "active");
  const pool = activeAccounts.length > 0 ? activeAccounts : accounts;

  for (const acc of pool) {
    const userId = String(acc.user_id);
    const marketplaceAccountId = String(acc.id);
    try {
      const accessToken = await getValidMLToken(userId, { marketplaceAccountId });
      const item = await fetchItem(accessToken, extListingId);
      const sellerId = item?.seller_id != null ? String(item.seller_id) : null;
      if (sellerId && String(acc.external_seller_id) === sellerId) {
        return {
          userId,
          marketplaceAccountId,
          sellerCompanyId: acc.seller_company_id != null ? String(acc.seller_company_id) : null,
          listingRowId: null,
          externalListingId: item?.id != null ? String(item.id) : extListingId,
          source: `account_match:${acc.ml_nickname || marketplaceAccountId}`,
          title: item?.title ?? null,
        };
      }
    } catch {
      /* tenta próxima conta */
    }
  }

  if (pool.length === 1) {
    const acc = pool[0];
    return {
      userId: String(acc.user_id),
      marketplaceAccountId: String(acc.id),
      sellerCompanyId: acc.seller_company_id != null ? String(acc.seller_company_id) : null,
      listingRowId: null,
      externalListingId: extListingId,
      source: "single_active_account",
      title: null,
    };
  }

  throw new Error(`Não foi possível resolver conta ML para o anúncio ${extListingId}`);
}

/**
 * @param {string} extListingId
 */
async function syncOne(extListingId) {
  const ctx = await resolveAccountForListing(extListingId);
  const tokenOpts = ctx.marketplaceAccountId
    ? { marketplaceAccountId: ctx.marketplaceAccountId }
    : {};
  const accessToken = await getValidMLToken(ctx.userId, tokenOpts);

  const extId = ctx.externalListingId || extListingId;
  const item = await fetchItem(accessToken, extId);
  if (!item || typeof item !== "object" || item.id == null) {
    throw new Error(`Item ML não encontrado: ${extId}`);
  }

  const enriched = await enrichItemWithListingPricesFees(accessToken, item, { healthSync: true });

  let description = null;
  try {
    description = await fetchItemDescription(accessToken, String(item.id));
  } catch (de) {
    console.warn("[sync] description_skip", { extId, message: de?.message });
  }

  console.log("[sync] ML item fetched", {
    external_listing_id: String(item.id),
    title: item.title ?? ctx.title ?? null,
    status: item.status ?? null,
    price: item.price ?? null,
    account_source: ctx.source,
    user_id: ctx.userId,
  });

  const out = await persistMercadoLibreListing(supabase, ctx.userId, enriched, description, {
    accessToken,
    marketplaceAccountId: ctx.marketplaceAccountId ?? undefined,
    sellerCompanyId: ctx.sellerCompanyId ?? undefined,
    syncReason: "manual_sync_by_id_script",
    touchAutoSyncAt: true,
    log: (msg, extra) => console.log("[persist]", msg, extra ?? {}),
  });

  console.log("[sync] OK", {
    external_listing_id: String(item.id),
    listing_id: out?.listingId ?? ctx.listingRowId ?? null,
    user_id: ctx.userId,
  });

  return { external_listing_id: String(item.id), userId: ctx.userId, listingId: out?.listingId ?? null };
}

async function main() {
  const results = [];

  for (const mlb of listingIds) {
    try {
      const r = await syncOne(mlb);
      results.push({ external_listing_id: mlb, ok: true, ...r });
    } catch (e) {
      console.error("[sync] FAILED", mlb, e instanceof Error ? e.message : String(e));
      results.push({
        external_listing_id: mlb,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  console.log("\n=== RESUMO ===");
  console.log(JSON.stringify(results, null, 2));

  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
