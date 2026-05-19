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

/** IDs confirmados no DEV (seller com vendas reais dos 3 cases). */
const CASE_ITEM_IDS = {
  "39.81": "a51834b0-f2e5-4e7f-acb3-113376c180bf",
  "27.00": "d5920484-0613-45e5-939b-2e798b87ccda",
  "73.00": "5b486806-7d34-4ece-825e-331436e16779",
};

async function main() {
  let userId = process.env.S7_FEE_REFRESH_USER_ID?.trim() || "";
  if (!userId) {
    const { data: users, error: userErr } = await supabase
      .from("profiles")
      .select("id,email")
      .ilike("email", "ricardo@suse7.com.br")
      .limit(1);
    if (userErr) throw userErr;
    userId = users?.[0]?.id != null ? String(users[0].id) : "";
  }
  console.log("user_id (initial)", userId || "(scan all tenants)");

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from("sales_order_items")
    .select("id,user_id,gross_amount,marketplace,fee_amount,raw_json,created_at,unit_price,quantity")
    .eq("marketplace", "mercado_livre")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (userId) query = query.eq("user_id", userId);
  const { data: rows, error } = await query;
  if (error) throw error;

  /** @param {unknown} v */
  function normMoney(v) {
    if (v == null || v === "") return null;
    const n = Number(String(v).replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return n.toFixed(2);
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const byGross = new Map();
  for (const row of rows || []) {
    const fin = pickFin(row.raw_json);
    const fromFin = fin?.gross_sale_amount_brl != null ? normMoney(fin.gross_sale_amount_brl) : null;
    const fromCol = row.gross_amount != null ? normMoney(row.gross_amount) : null;
    const fromUnit =
      row.unit_price != null && row.quantity != null
        ? normMoney(Number(row.unit_price) * Number(row.quantity))
        : row.unit_price != null
          ? normMoney(row.unit_price)
          : null;
    const g = fromFin ?? fromCol ?? fromUnit;
    if (!g || !TARGET_GROSS.includes(g) || byGross.has(g)) continue;
    byGross.set(g, row);
  }

  console.log(
    "matched gross keys:",
    [...byGross.keys()],
    "from",
    (rows || []).length,
    "recent items",
  );

  let failures = 0;
  /** @type {Map<string, Record<string, unknown>>} */
  const forcedRows = new Map();
  for (const id of Object.values(CASE_ITEM_IDS)) {
    const { data: one, error: oneErr } = await supabase
      .from("sales_order_items")
      .select("id,user_id,gross_amount,marketplace,fee_amount,raw_json,created_at")
      .eq("id", id)
      .maybeSingle();
    if (oneErr) throw oneErr;
    if (one) {
      const g = normMoney(one.gross_amount) ?? grossFromRow(one);
      if (g) forcedRows.set(g, one);
    }
  }

  /** @param {Record<string, unknown>} row */
  function grossFromRow(row) {
    const fin = pickFin(row.raw_json);
    return fin?.gross_sale_amount_brl != null ? normMoney(fin.gross_sale_amount_brl) : null;
  }

  for (const gross of TARGET_GROSS) {
    const forcedId = CASE_ITEM_IDS[gross];
    const row =
      forcedRows.get(gross) ??
      (forcedId ? (rows || []).find((r) => String(r.id) === forcedId) : null) ??
      byGross.get(gross);
    if (!row) {
      failures += 1;
      console.error("NOT_FOUND gross", gross);
      continue;
    }
    const itemId = String(row.id);
    const ownerId = row.user_id != null ? String(row.user_id) : userId;
    if (!ownerId) {
      failures += 1;
      console.error("NO_USER_ID", gross, itemId);
      continue;
    }
    const before = pickFin(row.raw_json);
    console.log("\n--- refresh", gross, "item_id", itemId, "---");
    console.log("before fee", before?.marketplace_fee_amount_brl, "pct", before?.marketplace_fee_percent);

    const result = await refreshSaleFinancialContractByItemId(supabase, ownerId, itemId);
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
