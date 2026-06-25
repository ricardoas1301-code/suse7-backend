// ======================================================================
// Etapa onboarding ML: consolidação de taxas financeiras por item de venda.
// Escopo multiconta: user_id + marketplace + marketplace_account_id (+ seller_company_id quando houver).
// Idempotente: reaplica somente quando houver diferença material.
// ======================================================================

import { extractOrderLinePricing } from "../../handlers/ml/_helpers/mlSalesPersist.js";
import { extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails } from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";

const PAGE_SIZE = 500;
const EPSILON = 0.000001;

/** @param {unknown} v */
function toFinite(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number | null} a
 * @param {number | null} b
 */
function materiallyDifferent(a, b) {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > EPSILON;
}

/**
 * Consolida taxas por item a partir do raw_json do pedido já persistido.
 * Não chama API externa e não expõe token.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplace: string;
 *   marketplaceAccountId: string;
 *   sellerCompanyId?: string | null;
 *   deadlineMs: number;
 * }} ctx
 */
export async function runMlInitialFeesSyncTurn(supabase, ctx) {
  const userId = String(ctx.userId || "").trim();
  const marketplace = String(ctx.marketplace || "mercado_livre").trim();
  const marketplaceAccountId = String(ctx.marketplaceAccountId || "").trim();
  const sellerCompanyId =
    ctx.sellerCompanyId != null && String(ctx.sellerCompanyId).trim() !== ""
      ? String(ctx.sellerCompanyId).trim()
      : null;

  /** @type {string[]} */
  const warnings = [];
  let processed = 0;
  let updated = 0;
  let created = 0;
  let cursor = null;
  let keepRunning = true;

  while (Date.now() < ctx.deadlineMs && keepRunning) {
    let query = supabase
      .from("sales_order_items")
      .select(
        "id, raw_json, gross_amount, fee_amount, shipping_share_amount, tax_amount, net_amount, marketplace_account_id, seller_company_id"
      )
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("marketplace_account_id", marketplaceAccountId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);

    if (sellerCompanyId) {
      query = query.eq("seller_company_id", sellerCompanyId);
    }
    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data, error } = await query;
    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      processed += 1;
      const line = row.raw_json && typeof row.raw_json === "object" ? row.raw_json : null;
      if (!line) {
        warnings.push(`item:${row.id}:raw_json_ausente`);
        continue;
      }

      const pricing = extractOrderLinePricing(line);
      const grossCandidate = toFinite(pricing.gross);
      const feeCandidate = toFinite(pricing.fee);
      const netCandidate = toFinite(pricing.net);
      const taxCandidate = toFinite(
        line?.taxes?.[0]?.amount ?? line?.tax_amount ?? null
      );
      const shippingCandidate = toFinite(line?.shipping_cost_share ?? null);

      const patch = {};

      const grossCurrent = toFinite(row.gross_amount);
      if (grossCandidate != null && materiallyDifferent(grossCurrent, grossCandidate)) {
        patch.gross_amount = grossCandidate;
      }

      const feeCurrent = toFinite(row.fee_amount);
      if (feeCandidate != null && materiallyDifferent(feeCurrent, feeCandidate)) {
        patch.fee_amount = feeCandidate;
      }

      const shippingCurrent = toFinite(row.shipping_share_amount);
      if (shippingCandidate != null && materiallyDifferent(shippingCurrent, shippingCandidate)) {
        patch.shipping_share_amount = shippingCandidate;
      }

      const taxCurrent = toFinite(row.tax_amount);
      if (taxCandidate != null && materiallyDifferent(taxCurrent, taxCandidate)) {
        patch.tax_amount = taxCandidate;
      }

      const netCurrent = toFinite(row.net_amount);
      let recomputedNet = null;
      if (grossCandidate != null && feeCandidate != null) {
        recomputedNet = grossCandidate - feeCandidate;
        if (shippingCandidate != null) recomputedNet -= shippingCandidate;
        const positiveAdj = extractMercadoLivrePositiveAdjustmentsFromSaleFeeDetails(line?.sale_fee_details);
        if (positiveAdj != null) recomputedNet += positiveAdj;
      } else if (netCandidate != null) {
        recomputedNet = netCandidate;
      }
      if (recomputedNet != null && materiallyDifferent(netCurrent, recomputedNet)) {
        patch.net_amount = recomputedNet;
      }

      if (Object.keys(patch).length > 0) {
        patch.updated_at = new Date().toISOString();
        const { error: uErr } = await supabase.from("sales_order_items").update(patch).eq("id", row.id);
        if (uErr) {
          warnings.push(`item:${row.id}:${uErr.message}`);
        } else {
          updated += 1;
        }
      }
    }

    cursor = rows[rows.length - 1]?.id ?? null;
    keepRunning = rows.length === PAGE_SIZE;
  }

  return {
    ok: true,
    step: "fees",
    processed,
    created,
    updated,
    warnings: warnings.slice(-50),
  };
}

