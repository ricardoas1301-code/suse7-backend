#!/usr/bin/env node
import { readFileSync } from "fs";
import { fetchListingPricesForItemDetailed } from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { extractOfficialMercadoLibreListingPricesFee, extractSaleFee } from "../src/handlers/ml/_helpers/mlItemMoneyExtract.js";

try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\n/)) {
    const m = line.match(/^(ML_ACCESS_TOKEN|SUSE7_ML_ACCESS_TOKEN)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const token = process.env.ML_ACCESS_TOKEN?.trim() || process.env.SUSE7_ML_ACCESS_TOKEN?.trim();
if (!token) {
  console.error("NO_TOKEN");
  process.exit(1);
}

const cases = [
  {
    label: "608 109",
    item: {
      id: "MLB6086959274",
      site_id: "MLB",
      price: 109,
      category_id: "MLB186068",
      listing_type_id: "gold_pro",
      currency_id: "BRL",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "xd_drop_off" },
    },
  },
  {
    label: "608 65",
    item: {
      id: "MLB6086959274",
      site_id: "MLB",
      price: 65,
      category_id: "MLB186068",
      listing_type_id: "gold_pro",
      currency_id: "BRL",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "xd_drop_off" },
    },
  },
  {
    label: "330 85",
    item: {
      id: "MLB3303267547",
      site_id: "MLB",
      price: 85,
      category_id: "MLB1051",
      listing_type_id: "gold_pro",
      currency_id: "BRL",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "cross_docking" },
    },
  },
  {
    label: "330 35",
    item: {
      id: "MLB3303267547",
      site_id: "MLB",
      price: 35,
      category_id: "MLB1051",
      listing_type_id: "gold_pro",
      currency_id: "BRL",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "cross_docking" },
    },
  },
];

for (const c of cases) {
  const det = await fetchListingPricesForItemDetailed(token, c.item);
  const row = det.row;
  const official = extractOfficialMercadoLibreListingPricesFee(row);
  const derived = extractSaleFee(
    { ...c.item, ...(row ?? {}), sale_fee_details: row?.sale_fee_details, sale_fee_amount: row?.sale_fee_amount },
    { deriveFromPercent: true, listing: c.item, skipDeepExtract: false },
  );
  console.log("\n===", c.label, "===");
  console.log(
    JSON.stringify(
      {
        request_url: det.requestUrl,
        http_status: det.httpStatus,
        skip_reason: det.skipReason,
        row_listing_type_id: row?.listing_type_id ?? row?.mapping ?? null,
        sale_fee_amount: row?.sale_fee_amount ?? null,
        selling_fee: row?.selling_fee ?? null,
        has_sale_fee_details: Boolean(row?.sale_fee_details),
        official_extract: official,
        derived_extract: derived,
        response_snippet: det.rawJson,
      },
      null,
      2,
    ),
  );
}
