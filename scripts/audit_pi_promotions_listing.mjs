#!/usr/bin/env node
/**
 * Homologação E2E — aba Promoções Modal PI
 * Uso: node suse7-backend/scripts/audit_pi_promotions_listing.mjs [MLB6086602390] [...]
 *
 * Gera 4 dumps por promoção alvo:
 * 1. Raw ML (listagem + enrichment)
 * 2. Backend normalizado (promotion_offer_contract)
 * 3. Payload handler (POST pricing-scenarios → promotion_scenarios[])
 * 4. Resumo UI esperado (mini card + Clássico/Premium)
 */

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

import { buildMercadoLivreListingPricingScenariosPayload } from "../src/domain/pricing/mercadoLivreListingPricingScenarios.js";
import {
  buildCanonicalPromotionOfferContract,
  buildPromotionCardContract,
  enrichOfficialSellerPromotionRowsFromApi,
  extractOfficialPromotionFinancialRawFields,
  normalizeOfficialSellerPromotionsFromApi,
  resolveOfficialSellerPromotionFinancials,
  resolvePromotionUiFinancials,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";
import {
  fetchSellerPromotionItemsForListing,
  fetchSellerPromotionsByItemDetailed,
} from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
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

const TARGETS =
  process.argv.slice(2).filter(Boolean).length > 0
    ? process.argv.slice(2).filter(Boolean)
    : [
        "MLB6415546858",
        "MLB6487881250",
        "MLB3734084847",
        "MLB6248404078",
        "MLB6784329822",
        "MLB6086602390",
      ];

const ACEITE_MLB6415546858 = {
  "Oferta relâmpago": { final: "60.39", discount: "18.21", pct: "24" },
  "LIGHTNING": { final: "60.39", discount: "18.21", pct: "24" },
  "Liquida Full - Outlet": { final: "61.00", discount: "17.60", pct: "22" },
};

const ACEITE_MLB6487881250 = {
  "Top Oferta Papelaria": { final: "65.05", discount: "13.85", pct: "18" },
  "07.07 e Descontaco": { final: "65.05", discount: "13.85", pct: "18" },
  "07.07 e Descontaço": { final: "65.05", discount: "13.85", pct: "18" },
  "Liquida Full - Outlet": { final: "74.95", discount: "3.95", pct: "5" },
};

const ACEITE_MLB3734084847 = {
  "07.07 e Descontaco": { final: "115.99", discount: "29.01", pct: "20" },
  "07.07 e Descontaço": { final: "115.99", discount: "29.01", pct: "20" },
  "Liquida Full - Outlet": { final: "115.99", discount: "29.01", pct: "20" },
};

const ACEITE_MLB6086602390 = {
  "Festival Casa Nova": { final: "254.91", discount: "44.99", pct: "15" },
  "07.07 e Descontaço": { final: "270.54", discount: "29.36", pct: "10" },
  "7/7 SUPER Oferta CASA": { final: "239.92", discount: "59.98", pct: "20" },
  "Aumente suas vendas": { final: "231.00", discount: "68.90", pct: "23" },
  "Venda Casa e Decor": { final: "231.00", discount: "68.90", pct: "23" },
  "Liquida Full - Outlet": { final: "231.00", discount: "68.90", pct: "23" },
};

const ACEITE_MLB6784329822 = {
  "07.07 e Descontaço": { final: "64.01", discount: "10.98", pct: "15" },
  "07.07 e Descontaco": { final: "64.01", discount: "10.98", pct: "15" },
  "Top Oferta Construcao": { final: "53.29", discount: "21.70", pct: "29" },
  "Top Oferta Construção": { final: "53.29", discount: "21.70", pct: "29" },
  "Aumente suas vendas": { final: "56.00", discount: "18.99", pct: "25" },
  "Liquida Full - Outlet": { final: "56.00", discount: "18.99", pct: "25" },
};

const ACEITE_MLB6248404078 = {
  "Liquida Full - Outlet": { final: "189.90", discount: "10.00", pct: "5" },
};

/** @param {Record<string, unknown>} row */
function dumpRawMlFields(row) {
  const r = row ?? {};
  return {
    id: r.id ?? r.promotion_id ?? null,
    offer_id: r.offer_id ?? r.ref_id ?? null,
    promotion_type: r.type ?? r.promotion_type ?? null,
    status: r.status ?? r.raw_status ?? null,
    name: r.name ?? r.promotion_name ?? null,
    original_price: r.original_price ?? null,
    price: r.price ?? r.amount ?? r.deal_price ?? null,
    min_discounted_price: r.min_discounted_price ?? null,
    max_discounted_price: r.max_discounted_price ?? null,
    suggested_discounted_price: r.suggested_discounted_price ?? null,
    boosted_offer: r.boosted_offer ?? null,
    total_price_for_boosted_offer: r.total_price_for_boosted_offer ?? null,
    seller_percentage: r.seller_percentage ?? null,
    meli_percentage: r.meli_percentage ?? null,
    _suse7_price_enriched: r._suse7_price_enriched ?? null,
    raw_financial_keys: extractOfficialPromotionFinancialRawFields(
      /** @type {Record<string, unknown>} */ (r)
    ),
  };
}

/** @param {unknown} name @param {string} listingExternalId */
function matchAceiteKey(name, listingExternalId = "") {
  const n = name != null ? String(name).trim().toLowerCase() : "";
  const id = String(listingExternalId);
  let aceiteMap = ACEITE_MLB6086602390;
  if (id.includes("6784329822")) aceiteMap = ACEITE_MLB6784329822;
  else if (id.includes("6248404078")) aceiteMap = ACEITE_MLB6248404078;
  for (const key of Object.keys(aceiteMap)) {
    if (n.includes(key.toLowerCase())) return key;
  }
  return null;
}

async function auditListing(sb, externalListingId) {
  const { data: listing, error: listingErr } = await sb
    .from("marketplace_listings")
    .select("id,user_id,marketplace_account_id,external_listing_id,title,price,listing_type_id")
    .eq("external_listing_id", externalListingId)
    .maybeSingle();

  if (listingErr || !listing) {
    return { external_listing_id: externalListingId, error: listingErr?.message ?? "listing_not_found" };
  }

  const userId = String(listing.user_id);
  const marketplaceAccountId =
    listing.marketplace_account_id != null ? String(listing.marketplace_account_id) : null;

  let mlToken = null;
  try {
    mlToken = await getValidMLToken(userId, {
      marketplaceAccountId: marketplaceAccountId ?? undefined,
    });
  } catch (e) {
    return {
      external_listing_id: externalListingId,
      error: `ml_token: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const fetchResult = await fetchSellerPromotionsByItemDetailed(mlToken, externalListingId);
  let rawRows = fetchResult.rows ?? [];
  const rawListagem = rawRows.map((row) => dumpRawMlFields(row));

  if (rawRows.length > 0) {
    rawRows = await enrichOfficialSellerPromotionRowsFromApi(
      mlToken,
      externalListingId,
      rawRows,
      fetchSellerPromotionItemsForListing
    );
  }
  const rawEnriched = rawRows.map((row) => dumpRawMlFields(row));

  /** @type {Record<string, unknown>[]} */
  const backendNormalized = [];
  for (const row of rawRows) {
    if (!row || typeof row !== "object") continue;
    const ui = resolvePromotionUiFinancials(row, {
      sameListingOtherPromotionPrices: rawRows
        .filter((other) => other !== row)
        .map((other) => {
          const otherUi = resolvePromotionUiFinancials(other, { skipLiquidaCaseAudit: true });
          return otherUi.final_price_brl;
        })
        .filter(Boolean),
      skipLiquidaCaseAudit: false,
    });
    const normalized = normalizeOfficialSellerPromotionsFromApi([row], { source: "live" }).promotions[0];
    const fin = resolveOfficialSellerPromotionFinancials(row, ui.final_price_brl, ui.original_price_brl);
    const contract = buildCanonicalPromotionOfferContract({
      listingExternalId: externalListingId,
      marketplaceAccountId,
      promotionRow: row,
      normalizedPromotion: normalized ?? {},
      financials: fin,
      listingCatalogPriceBrl: listing.price != null ? String(listing.price) : null,
    });
    const cardContract = buildPromotionCardContract({
      listingExternalId: externalListingId,
      marketplaceAccountId,
      promotionRow: row,
      normalizedPromotion: normalized ?? {},
      sameListingPromotionRows: rawRows,
    });
    backendNormalized.push({
      promotion_name: cardContract.promotion_name ?? contract.promotion_name,
      promotion_id: cardContract.promotion_id ?? contract.promotion_id,
      ui_financials: ui,
      promotion_card_contract: cardContract,
      promotion_offer_contract: contract,
    });
  }

  const handler = await buildMercadoLivreListingPricingScenariosPayload(sb, userId, {
    listingExternalId: externalListingId,
    scenarioScope: "pricing_opportunities",
    referenceZipCode: env.SUSE7_ML_PRICING_REFERENCE_ZIP ?? "01310100",
  });

  /** @type {Record<string, unknown>[]} */
  const handlerPromos = [];
  if (handler.ok && handler.data?.promotion_scenarios) {
    for (const row of handler.data.promotion_scenarios) {
      if (!row || typeof row !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (row);
      const contract =
        r.promotion_offer_contract != null && typeof r.promotion_offer_contract === "object"
          ? r.promotion_offer_contract
          : null;
      const cardContract =
        r.promotion_card_contract != null && typeof r.promotion_card_contract === "object"
          ? r.promotion_card_contract
          : null;
      handlerPromos.push({
        promotion_name: r.promotion_name ?? cardContract?.promotion_name ?? contract?.promotion_name ?? null,
        promotion_id: r.promotion_id ?? cardContract?.promotion_id ?? contract?.promotion_id ?? null,
        marketplace_sale_price_brl:
          r.marketplace != null && typeof r.marketplace === "object"
            ? /** @type {Record<string, unknown>} */ (r.marketplace).sale_price_brl
            : null,
        promotion_card_contract: cardContract,
        promotion_offer_contract: contract,
      });
    }
  }

  /** @type {Record<string, unknown>[]} */
  const uiExpectations = [];
  for (const promo of handlerPromos) {
    const cardContract =
      promo.promotion_card_contract != null && typeof promo.promotion_card_contract === "object"
        ? /** @type {Record<string, unknown>} */ (promo.promotion_card_contract)
        : null;
    const contract =
      promo.promotion_offer_contract != null && typeof promo.promotion_offer_contract === "object"
        ? /** @type {Record<string, unknown>} */ (promo.promotion_offer_contract)
        : null;
    const priceContract = cardContract ?? contract;
    const name = promo.promotion_name ?? priceContract?.promotion_name ?? "";
    const aceiteKey = matchAceiteKey(name, externalListingId);
    const id = String(externalListingId);
    let aceiteMap = ACEITE_MLB6086602390;
    if (id.includes("6415546858")) aceiteMap = ACEITE_MLB6415546858;
    else if (id.includes("6487881250")) aceiteMap = ACEITE_MLB6487881250;
    else if (id.includes("3734084847")) aceiteMap = ACEITE_MLB3734084847;
    else if (id.includes("6784329822")) aceiteMap = ACEITE_MLB6784329822;
    else if (id.includes("6248404078")) aceiteMap = ACEITE_MLB6248404078;
    const esperado = aceiteKey ? aceiteMap[aceiteKey] : null;
    const finalPrice =
      cardContract?.real_promotion_final_price_brl ??
      contract?.buyer_final_price_brl ??
      contract?.final_price_brl ??
      promo.marketplace_sale_price_brl ??
      null;
    uiExpectations.push({
      promotion_name: name,
      mini_card_final_brl: finalPrice,
      mini_card_pct: priceContract?.discount_percent_display ?? null,
      mini_card_discount_brl: priceContract?.discount_amount_brl ?? null,
      classic_premium_sale_brl: finalPrice,
      aceite: esperado,
      ok:
        esperado != null &&
        finalPrice === esperado.final &&
        priceContract?.discount_amount_brl === esperado.discount &&
        String(priceContract?.discount_percent_display ?? "") === esperado.pct,
    });
  }

  return {
    external_listing_id: externalListingId,
    listing_title: listing.title ?? null,
    route: "POST /api/ml/listings/pricing-scenarios",
    scenario_scope: "pricing_opportunities",
    dumps: {
      "1_raw_ml_listagem": rawListagem,
      "1b_raw_ml_enriched": rawEnriched,
      "2_backend_normalized": backendNormalized,
      "3_handler_promotion_scenarios": handlerPromos,
      "4_ui_expectations": uiExpectations,
    },
    handler_ok: handler.ok === true,
    handler_error: handler.ok ? null : handler.error ?? null,
  };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (.env.local ou env).");
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const results = [];
  for (const id of TARGETS) {
    console.log(`\n=== Audit PI promoções: ${id} ===`);
    const report = await auditListing(sb, id);
    results.push(report);
    if (report.error) {
      console.error("ERRO:", report.error);
      continue;
    }
    const ui = report.dumps?.["4_ui_expectations"];
    if (Array.isArray(ui)) {
      for (const row of ui) {
        const flag = row.ok === true ? "OK" : row.aceite != null ? "FAIL" : "INFO";
        console.log(
          `[${flag}] ${row.promotion_name}: final=${row.classic_premium_sale_brl} pct=${row.mini_card_pct}% disc=${row.mini_card_discount_brl}`
        );
      }
    }
  }

  const outDir = path.join(repoRoot, "scripts", "output");
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `AUDIT_PI_PROMOTIONS_E2E_${stamp}.json`);
  await fs.writeFile(outFile, JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  console.log(`\nRelatório: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
