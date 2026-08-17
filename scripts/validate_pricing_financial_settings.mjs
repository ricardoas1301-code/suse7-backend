#!/usr/bin/env node
/**
 * Valida parse/persist/read de financial settings (Precificação → Raio-x).
 */
import dotenv from "dotenv";
import {
  parseFinancialSettingsBody,
  financialSettingsFromConfig,
  readListingFinancialSettings,
  persistListingFinancialSettings,
} from "../src/domain/pricing/listingFinancialSettings.js";
import { buildSaleDetailExtraInternalAdjustments } from "../src/domain/sales/saleDetailExtraInternalAdjustments.js";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const config = parseFinancialSettingsBody({
    promo_discount_percent: "5.5",
    ml_ads_percent: "0",
    affiliate_percent: "12",
    reserve_percent: "3",
    promo_discount_enabled: true,
    ml_ads_enabled: false,
    affiliates_enabled: true,
    reserve_enabled: true,
  });
  const flat = financialSettingsFromConfig(config);
  assert(flat.promo_discount_percent === "5.50", "promo pct");
  assert(flat.ml_ads_percent === "0.00", "ml ads off");
  assert(flat.affiliate_percent === "12.00", "affiliate");
  const extra = buildSaleDetailExtraInternalAdjustments(config);
  assert(extra.promo_discount_percent === "5.50", "extra promo");
  console.log("parse OK", flat, extra);

  const { data: listing } = await supabase
    .from("marketplace_listings")
    .select("id, raw_json, marketplace, external_listing_id, marketplace_account_id, seller_company_id, user_id")
    .limit(1)
    .maybeSingle();
  if (!listing) {
    console.log("sem listing no DEV — skip persist");
    return;
  }

  const persist = await persistListingFinancialSettings(supabase, listing.user_id, listing, config);
  assert(persist.ok, persist.error ?? "persist failed");
  const readBack = await readListingFinancialSettings(supabase, listing.user_id, listing);
  assert(readBack.financial_settings.promo_discount_percent === "5.50", "readback promo");
  console.log("persist/read OK", readBack);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
