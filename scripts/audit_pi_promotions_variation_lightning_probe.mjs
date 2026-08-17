// ======================================================================
// Probe — variações/faixas (MLB6526137900) + relâmpago (MLB6415546858)
// Não entra no aceite principal de anúncios simples.
// ======================================================================

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(backendRoot, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
const { createClient } = require("@supabase/supabase-js");

import {
  buildPromotionVariationRangeAuditPayload,
  inferPromotionPriceDiscountRanges,
  listingHasMultipleVariations,
} from "../src/domain/pricing/mercadoLivrePromotionVariationRangeAudit.js";
import { pickOriginalPriceDec } from "../src/domain/pricing/mercadoLivrePromotionPriceResolverRegistry.js";
import {
  enrichOfficialSellerPromotionRowsFromApi,
  resolvePromotionUiFinancials,
  tipoIndicaRelampagoPromocao,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";
import {
  fetchSellerPromotionItemsForListing,
  fetchSellerPromotionsByItemDetailed,
} from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** @param {Record<string, unknown>} obj @param {number} depth */
function shallowKeysDeep(obj, depth = 0) {
  if (obj == null || typeof obj !== "object" || depth > 2) return obj;
  if (Array.isArray(obj)) {
    return obj.slice(0, 5).map((v) => shallowKeysDeep(v, depth + 1));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && typeof v === "object" && !Array.isArray(v) && depth < 2) {
      out[k] = Object.keys(/** @type {Record<string, unknown>} */ (v));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} externalListingId
 */
async function probeListing(sb, externalListingId) {
  const { data: listing, error: listingErr } = await sb
    .from("marketplace_listings")
    .select("id,user_id,marketplace_account_id,external_listing_id,title,price,variations_count,raw_json")
    .eq("external_listing_id", externalListingId)
    .maybeSingle();

  if (listingErr || !listing) {
    return { external_listing_id: externalListingId, error: listingErr?.message ?? "listing_not_found" };
  }

  const userId = String(listing.user_id);
  const mlToken = await getValidMLToken(userId, {
    marketplaceAccountId:
      listing.marketplace_account_id != null ? String(listing.marketplace_account_id) : undefined,
  });

  const fetchResult = await fetchSellerPromotionsByItemDetailed(mlToken, externalListingId);
  let rawRows = fetchResult.rows ?? [];

  /** @type {Record<string, Record<string, unknown>[]>} */
  const promotionItemsByKey = {};

  if (rawRows.length > 0) {
    for (const row of rawRows) {
      if (!row || typeof row !== "object") continue;
      const pid = row.id ?? row.promotion_id;
      const ptype = row.type ?? row.promotion_type;
      if (pid == null || ptype == null) continue;
      try {
        const items = await fetchSellerPromotionItemsForListing(
          mlToken,
          String(pid).trim(),
          String(ptype).trim(),
          externalListingId
        );
        promotionItemsByKey[`${pid}|${ptype}`] = items.map((it) => shallowKeysDeep(it));
      } catch (e) {
        promotionItemsByKey[`${pid}|${ptype}`] = [
          { error: e instanceof Error ? e.message : String(e) },
        ];
      }
    }

    rawRows = await enrichOfficialSellerPromotionRowsFromApi(
      mlToken,
      externalListingId,
      rawRows,
      fetchSellerPromotionItemsForListing
    );
  }

  const listingContext = {
    variations_count: listing.variations_count ?? null,
    raw_json:
      listing.raw_json != null && typeof listing.raw_json === "object"
        ? /** @type {Record<string, unknown>} */ (listing.raw_json)
        : null,
  };

  /** @type {Record<string, unknown>[]} */
  const promotions = [];
  for (const row of rawRows) {
    if (!row || typeof row !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    const pid = r.id ?? r.promotion_id;
    const ptype = r.type ?? r.promotion_type;
    const itemsKey = pid != null && ptype != null ? `${pid}|${ptype}` : null;
    const enrichmentItemRows = itemsKey != null ? promotionItemsByKey[itemsKey] ?? null : null;

    const ui = resolvePromotionUiFinancials(r, {
      listingId: externalListingId,
      listingContext,
      enrichmentItemRows,
      skipLiquidaCaseAudit: true,
    });

    const ranges = inferPromotionPriceDiscountRanges(r, pickOriginalPriceDec(r));

    promotions.push({
      promotion_id: pid ?? null,
      promotion_name: r.name ?? r.promotion_name ?? null,
      promotion_type: ptype ?? null,
      status: r.status ?? null,
      listing_has_variations: listingHasMultipleVariations(listingContext),
      raw_row_keys: Object.keys(r),
      raw_row_snapshot: shallowKeysDeep(r),
      enrichment_items_count: Array.isArray(enrichmentItemRows) ? enrichmentItemRows.length : 0,
      enrichment_items: enrichmentItemRows,
      inferred_ranges: ranges,
      resolved_ui: {
        final_price_brl: ui.final_price_brl,
        final_price_source: ui.final_price_source,
        discount_amount_brl: ui.discount_amount_brl,
        discount_percent_display: ui.discount_percent_display,
        source_warnings: ui.source_warnings,
      },
      variation_range_audit: buildPromotionVariationRangeAuditPayload({
        row: r,
        selectedFinalPriceBrl: ui.final_price_brl,
        selectedFinalPriceSource: ui.final_price_source,
        listingId: externalListingId,
        listingContext,
        enrichmentItemRows,
      }),
      is_lightning: tipoIndicaRelampagoPromocao(ptype),
    });
  }

  return {
    external_listing_id: externalListingId,
    listing_title: listing.title ?? null,
    variations_count: listing.variations_count ?? null,
    listing_has_variations: listingHasMultipleVariations(listingContext),
    raw_variations_sample: Array.isArray(listingContext.raw_json?.variations)
      ? listingContext.raw_json.variations.slice(0, 3).map((v) => shallowKeysDeep(v))
      : [],
    fetch_ok: fetchResult.ok === true,
    fetch_http_status: fetchResult.httpStatus ?? null,
    promotions,
  };
}

async function main() {
  const env = {
    ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
    ...parseDotEnv(path.join(backendRoot, ".env.local")),
    ...parseDotEnv(path.join(repoRoot, ".env.local")),
    ...process.env,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value != null && String(value).trim() !== "" && process.env[key] == null) {
      process.env[key] = String(value).replace(/^["']|["']$/g, "");
    }
  }

  const SUPABASE_URL = env.SUPABASE_URL?.replace(/^["']|["']$/g, "") ?? process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY =
    env.SUPABASE_SERVICE_ROLE_KEY?.replace(/^["']|["']$/g, "") ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const targets =
    process.argv.slice(2).filter(Boolean).length > 0
      ? process.argv.slice(2).filter(Boolean)
      : ["MLB6526137900", "MLB6415546858"];

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const results = [];
  for (const id of targets) {
    console.log(`\n=== Probe variação/relâmpago: ${id} ===`);
    const report = await probeListing(sb, id);
    results.push(report);
    if (report.error) {
      console.error("ERRO:", report.error);
      continue;
    }
    console.log(
      `variations_count=${report.variations_count} has_variations=${report.listing_has_variations} promos=${report.promotions?.length ?? 0}`
    );
    for (const p of report.promotions ?? []) {
      const audit = p.variation_range_audit;
      const flag = audit?.silent_single_price_selected ? "WARN" : "INFO";
      console.log(
        `[${flag}] ${p.promotion_name ?? p.promotion_type}: final=${p.resolved_ui?.final_price_brl} range=${audit?.price_range_min}-${audit?.price_range_max} silent=${audit?.silent_single_price_selected}`
      );
      if (p.is_lightning) {
        console.log("  lightning enrichment items:", JSON.stringify(p.enrichment_items, null, 2));
      }
    }
  }

  const outDir = path.join(repoRoot, "scripts", "output");
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `AUDIT_PI_VARIATION_LIGHTNING_PROBE_${stamp}.json`);
  await fs.writeFile(outFile, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  console.log(`\nRelatório: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
