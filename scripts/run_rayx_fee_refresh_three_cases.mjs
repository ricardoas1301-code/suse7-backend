/**
 * Localiza vendas ML com bruto 39.81 / 27.00 / 73.00 e executa refresh do contrato marketplace_fee.
 * Uso: node scripts/run_rayx_fee_refresh_three_cases.mjs
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { refreshSaleFinancialContractByItemId } from "../src/services/sales/saleFinancialContractRefresh.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const TARGET_GROSS = ["39.81", "27.00", "73.00"];
const EXPECTED = {
  "39.81": { percent: "16.5", fee: "6.57", label: "Premium" },
  "27.00": { percent: "11.5", fee: "3.10", label: "Clássico" },
  "73.00": { percent: "16.5", fee: "12.04", label: "Premium" },
};

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios (.env.vercel ou .env.local)");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

/** @param {unknown} raw */
function pickFin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fin = /** @type {Record<string, unknown>} */ (raw)._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

async function main() {
  const { data: users, error: userErr } = await supabase
    .from("profiles")
    .select("id,email")
    .ilike("email", "ricardo@suse7.com.br")
    .limit(1);
  if (userErr) throw userErr;
  const userId = users?.[0]?.id != null ? String(users[0].id) : null;
  if (!userId) {
    console.error("Usuário ricardo@suse7.com.br não encontrado em profiles");
    process.exit(1);
  }
  console.log("user_id", userId);

  const { data: rows, error } = await supabase
    .from("sales_order_items")
    .select("id,gross_amount,marketplace,listing_type_id,fee_amount,raw_json,created_at")
    .eq("user_id", userId)
    .eq("marketplace", "mercado_livre")
    .in("gross_amount", TARGET_GROSS)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  /** @type {Map<string, Record<string, unknown>>} */
  const byGross = new Map();
  for (const row of rows || []) {
    const g = row.gross_amount != null ? String(row.gross_amount) : "";
    if (!TARGET_GROSS.includes(g) || byGross.has(g)) continue;
    byGross.set(g, row);
  }

  let failures = 0;
  for (const gross of TARGET_GROSS) {
    const row = byGross.get(gross);
    if (!row) {
      failures += 1;
      console.error("NOT_FOUND gross", gross);
      continue;
    }
    const itemId = String(row.id);
    const before = pickFin(row.raw_json);
    console.log("\n--- refresh", gross, "item_id", itemId, "---");
    console.log("before fee", before?.marketplace_fee_amount_brl, "pct", before?.marketplace_fee_percent);

    const result = await refreshSaleFinancialContractByItemId(supabase, userId, itemId);
    if (!result.ok) {
      failures += 1;
      console.error("refresh_failed", gross, result);
      continue;
    }

    const after = result.marketplace_fee_after;
    const exp = EXPECTED[gross];
    const okFee = after?.amount_brl === exp.fee;
    const okPct = after?.percentage === exp.percent || after?.percentage === `${exp.percent}.00`;
    const okLabel = after?.listing_type_label === exp.label;

    console.log("after", {
      amount_brl: after?.amount_brl,
      percentage: after?.percentage,
      listing_type_label: after?.listing_type_label,
      percent_source: after?.percent_source,
      mode: result.mode,
    });

    if (!okFee || !okPct || !okLabel) {
      failures += 1;
      console.error("VALIDATION_FAIL", gross, { okFee, okPct, okLabel, exp });
    } else {
      console.log("VALIDATION_OK", gross);
    }
  }

  if (failures > 0) process.exit(1);
  console.log("\nAll three cases refreshed and validated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
