/**
 * Refresh do contrato marketplace_fee — cases históricos reais (DEV).
 * Uso: node scripts/run_rayx_fee_refresh_three_cases.mjs
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { refreshSaleFinancialContractByItemId } from "../src/services/sales/saleFinancialContractRefresh.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const EXPECTED = {
  "295.45": { percent: "13.5", fee: "39.89", label: "Premium" },
  "400.50": { percent: "13.5", fee: "54.07", label: "Premium" },
  "39.81": { percent: "16.5", fee: "6.57", label: "Premium" },
  "27.00": { percent: "11.5", fee: "3.10", label: "Clássico" },
  "73.00": { percent: "16.5", fee: "12.04", label: "Premium" },
};

const CASE_ITEM_IDS = {
  "295.45": "8572c809-6c60-4f3c-8ea4-d9d7b8d9ad38",
  "400.50": "8b1b8660-5452-4b29-a23d-a5b2c45f00ce",
  "39.81": "a23a61b9-40ae-4d35-9cb5-9c825cfc03ae",
  "27.00": "62797649-32b7-4e11-a18c-07479e08edbd",
  "73.00": "29177389-ff28-4bb7-9819-eb8d5785622e",
};

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

/** @param {unknown} raw */
function pickFin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fin = /** @type {Record<string, unknown>} */ (raw)._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

/** @param {unknown} v */
function normMoney(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

async function main() {
  let failures = 0;

  for (const [gross, itemId] of Object.entries(CASE_ITEM_IDS)) {
    const { data: row, error } = await supabase
      .from("sales_order_items")
      .select("id,user_id,gross_amount,fee_amount,raw_json,external_order_id,external_listing_id")
      .eq("id", itemId)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      failures += 1;
      console.error("NOT_FOUND", gross, itemId);
      continue;
    }

    const ownerId = String(row.user_id);
    const before = pickFin(row.raw_json);
    console.log("\n---", gross, itemId, "---");
    console.log("before", before?.marketplace_fee_amount_brl, before?.marketplace_fee_percent);

    const result = await refreshSaleFinancialContractByItemId(supabase, ownerId, itemId);
    if (!result.ok) {
      failures += 1;
      console.error("refresh_failed", result);
      continue;
    }

    const after = result.marketplace_fee_after;
    const exp = EXPECTED[gross];
    const okFee = after?.amount_brl === exp.fee;
    const okPct = after?.percentage === exp.percent;
    const okLabel = after?.listing_type_label === exp.label;
    const okNotFallback = after?.percentage_source !== "fallback_listing_type";

    console.log("after", {
      amount_brl: after?.amount_brl,
      percentage: after?.percentage,
      percentage_source: after?.percentage_source,
      raw_amount_source_path: after?.raw_amount_source_path,
      raw_percentage_source_path: after?.raw_percentage_source_path,
      is_estimated: after?.is_estimated,
    });

    if (!okFee || !okPct || !okLabel || !okNotFallback) {
      failures += 1;
      console.error("VALIDATION_FAIL", { okFee, okPct, okLabel, okNotFallback, exp });
    } else {
      console.log("VALIDATION_OK", gross);
    }
  }

  if (failures > 0) process.exit(1);
  console.log("\nAll cases refreshed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
