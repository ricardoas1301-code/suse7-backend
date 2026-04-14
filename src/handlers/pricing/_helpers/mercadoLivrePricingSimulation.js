// ======================================================
// Precificação inteligente — simulação Mercado Livre (Decimal + net_proceeds + Raio-x).
// Multi-marketplace: por ora só ML; gateway pode delegar para este módulo.
// ======================================================

import Decimal from "decimal.js";
import { ML_MARKETPLACE_SLUG } from "../../ml/_helpers/mlMarketplace.js";
import { externalListingIdKeyVariants } from "../../ml/_helpers/listingGridJoinKeys.js";
import { computeMercadoLivreUnitNetProceeds } from "../../ml/_helpers/netProceeds/mercadoLivreNetProceedsCalculator.js";
import { buildMercadoLivrePricingContext } from "../../ml/_helpers/marketplaces/mercadoLivreRaioxPricing.js";

/**
 * Evita que repasse “oficial” antigo do health ancore o cenário com preço novo.
 */
function cloneHealthForSimulation(health) {
  if (!health || typeof health !== "object") return health;
  return {
    ...health,
    net_receivable: null,
    marketplace_payout_amount: null,
    marketplace_payout_amount_brl: null,
    promotion_price: null,
    promotional_price_brl: null,
  };
}

function listingWithSalePrice(listing, priceDec) {
  const s = priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return { ...listing, price: s };
}

function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function resultSnapshot(ctx) {
  if (!ctx || typeof ctx !== "object") return null;
  const res = /** @type {Record<string, unknown>} */ (ctx).result;
  return res && typeof res === "object" ? /** @type {Record<string, unknown>} */ (res) : null;
}

/**
 * Carrega listing + health + métricas no mesmo espírito do GET /api/ml/listings.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingUuid
 */
export async function loadMercadoLivreListingPricingInputs(supabase, userId, listingUuid) {
  const { data: row, error: qErr } = await supabase
    .from("marketplace_listings")
    .select(
      "id, user_id, title, marketplace, price, base_price, original_price, available_quantity, sold_quantity, status, external_listing_id, permalink, currency_id, pictures_count, variations_count, seller_sku, seller_custom_field, listing_type_id, raw_json, product_id, attention_reason, products(product_name, sku, cost_price, operational_cost, packaging_cost)"
    )
    .eq("id", listingUuid)
    .eq("user_id", userId)
    .maybeSingle();

  if (qErr || !row) {
    return { ok: false, error: "Anúncio não encontrado.", status: 404 };
  }

  const marketplace = row.marketplace != null ? String(row.marketplace) : "";
  if (marketplace !== ML_MARKETPLACE_SLUG && marketplace !== "mercadolivre") {
    return {
      ok: false,
      error: "Precificação S7 nesta versão só está disponível para Mercado Livre.",
      status: 400,
    };
  }

  const { products: prodRel, ...rest } = row;
  const pr =
    prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
      ? /** @type {Record<string, unknown>} */ (prodRel)
      : Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
        ? /** @type {Record<string, unknown>} */ (prodRel[0])
        : null;
  const product_cost_row =
    pr != null
      ? {
          cost_price: pr.cost_price,
          operational_cost: pr.operational_cost,
          packaging_cost: pr.packaging_cost,
        }
      : null;

  const product_name =
    pr != null && pr.product_name != null && String(pr.product_name).trim() !== ""
      ? String(pr.product_name).trim()
      : null;
  const product_sku =
    pr != null && pr.sku != null && String(pr.sku).trim() !== "" ? String(pr.sku).trim() : null;

  /** @type {Record<string, unknown>} */
  const listing = { ...rest, product_cost_row, product_name, product_sku };

  const ext = row.external_listing_id != null ? String(row.external_listing_id).trim() : "";
  const variants = externalListingIdKeyVariants(ext);

  const { data: healthRows, error: hErr } = await supabase
    .from("marketplace_listing_health")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("external_listing_id", variants.length ? variants : [""])
    .limit(1);

  if (hErr) {
    console.error("[pricing/simulate] health_query", hErr);
    return { ok: false, error: "Erro ao carregar saúde do anúncio.", status: 500 };
  }
  const health =
    healthRows && healthRows[0] && typeof healthRows[0] === "object"
      ? /** @type {Record<string, unknown>} */ (healthRows[0])
      : null;

  const { data: metRows, error: mErr } = await supabase
    .from("listing_sales_metrics")
    .select(
      "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, commission_amount_total, shipping_share_total, orders_count, last_sale_at"
    )
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("external_listing_id", variants.length ? variants : [""])
    .limit(1);

  if (mErr) {
    console.error("[pricing/simulate] metrics_query", mErr);
  }
  const metrics =
    metRows && metRows[0] && typeof metRows[0] === "object"
      ? /** @type {Record<string, unknown>} */ (metRows[0])
      : null;

  const { data: profileTaxRow } = await supabase
    .from("profiles")
    .select("imposto_percentual")
    .eq("id", userId)
    .maybeSingle();
  const sellerTaxPct =
    profileTaxRow?.imposto_percentual != null && String(profileTaxRow.imposto_percentual).trim() !== ""
      ? String(profileTaxRow.imposto_percentual).trim()
      : null;

  return {
    ok: true,
    listing,
    health,
    metrics,
    sellerTaxPct,
    external_listing_id: ext,
  };
}

/**
 * Mesmo carregamento que {@link loadMercadoLivreListingPricingInputs}, por `external_listing_id` (ex.: MLB…).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} externalListingIdRaw
 */
export async function loadMercadoLivreListingPricingInputsByExternalId(supabase, userId, externalListingIdRaw) {
  const ext = externalListingIdRaw != null ? String(externalListingIdRaw).trim() : "";
  if (!ext) {
    return { ok: false, error: "Informe o ID do anúncio no Mercado Livre.", status: 400 };
  }
  const variants = externalListingIdKeyVariants(ext);
  const { data: row, error: qErr } = await supabase
    .from("marketplace_listings")
    .select(
      "id, user_id, title, marketplace, price, base_price, original_price, available_quantity, sold_quantity, status, external_listing_id, permalink, currency_id, pictures_count, variations_count, seller_sku, seller_custom_field, listing_type_id, raw_json, product_id, attention_reason, products(product_name, sku, cost_price, operational_cost, packaging_cost)"
    )
    .eq("user_id", userId)
    .in("external_listing_id", variants.length ? variants : [ext])
    .limit(1)
    .maybeSingle();

  if (qErr || !row) {
    return { ok: false, error: "Anúncio não encontrado.", status: 404 };
  }

  const marketplace = row.marketplace != null ? String(row.marketplace) : "";
  if (marketplace !== ML_MARKETPLACE_SLUG && marketplace !== "mercadolivre") {
    return {
      ok: false,
      error: "Precificação S7 nesta versão só está disponível para Mercado Livre.",
      status: 400,
    };
  }

  const { products: prodRel, ...rest } = row;
  const pr =
    prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
      ? /** @type {Record<string, unknown>} */ (prodRel)
      : Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
        ? /** @type {Record<string, unknown>} */ (prodRel[0])
        : null;
  const product_cost_row =
    pr != null
      ? {
          cost_price: pr.cost_price,
          operational_cost: pr.operational_cost,
          packaging_cost: pr.packaging_cost,
        }
      : null;

  const product_name =
    pr != null && pr.product_name != null && String(pr.product_name).trim() !== ""
      ? String(pr.product_name).trim()
      : null;
  const product_sku =
    pr != null && pr.sku != null && String(pr.sku).trim() !== "" ? String(pr.sku).trim() : null;

  /** @type {Record<string, unknown>} */
  const listing = { ...rest, product_cost_row, product_name, product_sku };

  const extNorm = row.external_listing_id != null ? String(row.external_listing_id).trim() : "";
  const variantsH = externalListingIdKeyVariants(extNorm);

  const { data: healthRows, error: hErr } = await supabase
    .from("marketplace_listing_health")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("external_listing_id", variantsH.length ? variantsH : [""])
    .limit(1);

  if (hErr) {
    console.error("[pricing/scenarios] health_query", hErr);
    return { ok: false, error: "Erro ao carregar saúde do anúncio.", status: 500 };
  }
  const health =
    healthRows && healthRows[0] && typeof healthRows[0] === "object"
      ? /** @type {Record<string, unknown>} */ (healthRows[0])
      : null;

  const { data: metRows, error: mErr } = await supabase
    .from("listing_sales_metrics")
    .select(
      "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, commission_amount_total, shipping_share_total, orders_count, last_sale_at"
    )
    .eq("user_id", userId)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .in("external_listing_id", variantsH.length ? variantsH : [""])
    .limit(1);

  if (mErr) {
    console.error("[pricing/scenarios] metrics_query", mErr);
  }
  const metrics =
    metRows && metRows[0] && typeof metRows[0] === "object"
      ? /** @type {Record<string, unknown>} */ (metRows[0])
      : null;

  const { data: profileTaxRow } = await supabase
    .from("profiles")
    .select("imposto_percentual")
    .eq("id", userId)
    .maybeSingle();
  const sellerTaxPct =
    profileTaxRow?.imposto_percentual != null && String(profileTaxRow.imposto_percentual).trim() !== ""
      ? String(profileTaxRow.imposto_percentual).trim()
      : null;

  return {
    ok: true,
    listing,
    health,
    metrics,
    sellerTaxPct,
    external_listing_id: extNorm,
  };
}

/**
 * @param {{
 *   listing: Record<string, unknown>;
 *   health: Record<string, unknown> | null;
 *   metrics: Record<string, unknown> | null;
 *   sellerTaxPct: string | null;
 *   salePriceCandidateStr: string;
 *   minMarginPct: number | null;
 *   minProfitBrl: number | null;
 * }} p
 */
export function runMercadoLivrePricingSimulation(p) {
  const { listing, health, metrics, sellerTaxPct, salePriceCandidateStr, minMarginPct, minProfitBrl } = p;

  let candidate;
  try {
    candidate = new Decimal(String(salePriceCandidateStr ?? "").trim().replace(",", "."));
  } catch {
    candidate = new Decimal(NaN);
  }
  if (!candidate.isFinite() || candidate.lte(0)) {
    return { ok: false, error: "Informe um preço de venda válido (maior que zero)." };
  }

  const productCosts =
    listing.product_cost_row && typeof listing.product_cost_row === "object"
      ? /** @type {Record<string, unknown>} */ (listing.product_cost_row)
      : null;

  const npCurrent = computeMercadoLivreUnitNetProceeds(listing, health, metrics);
  const ctxCurrent = buildMercadoLivrePricingContext({
    listing,
    health,
    netProceeds: npCurrent,
    productCosts,
    sellerTaxPct,
  });

  const listingSim = listingWithSalePrice(listing, candidate);
  const healthSim = cloneHealthForSimulation(health);
  const npSim = computeMercadoLivreUnitNetProceeds(listingSim, healthSim, metrics);
  const ctxSim = buildMercadoLivrePricingContext({
    listing: listingSim,
    health: healthSim,
    netProceeds: npSim,
    productCosts,
    sellerTaxPct,
  });

  const resCur = resultSnapshot(ctxCurrent);
  const resSim = resultSnapshot(ctxSim);

  const profitCur = toDec(resCur?.profit_brl);
  const profitSim = toDec(resSim?.profit_brl);
  const marginCur = toDec(resCur?.margin_pct);
  const marginSim = toDec(resSim?.margin_pct);
  const breakSim = toDec(resSim?.break_even_price_brl);

  /** @type {{ code: string; severity: string; message: string }[]} */
  const warnings = [];

  let profitDelta = null;
  if (profitCur != null && profitSim != null) profitDelta = profitSim.minus(profitCur);
  let marginDelta = null;
  if (marginCur != null && marginSim != null) marginDelta = marginSim.minus(marginCur);

  let profitDeltaPct = null;
  if (profitCur != null && profitSim != null && profitCur.gt(0)) {
    profitDeltaPct = profitSim.minus(profitCur).div(profitCur).mul(100);
  }

  if (breakSim != null && candidate.lt(breakSim)) {
    warnings.push({
      code: "below_break_even",
      severity: "high",
      message:
        "O preço simulado está abaixo do piso saudável. Ajuste o valor ou confirme o risco antes de publicar no ML.",
    });
  }

  const sem = resSim?.offer_status_semantic != null ? String(resSim.offer_status_semantic) : "";
  if (sem === "critical" || sem === "danger") {
    warnings.push({
      code: "offer_status_stressed",
      severity: sem === "critical" ? "high" : "medium",
      message: "Status da oferta simulada permanece em faixa de alerta ou crítica.",
    });
  }

  if (minMarginPct != null && Number.isFinite(minMarginPct) && marginSim != null) {
    const minM = new Decimal(minMarginPct);
    if (marginSim.lt(minM)) {
      warnings.push({
        code: "below_min_margin_desired",
        severity: "medium",
        message: `Margem simulada inferior à mínima desejada (${minM.toFixed(2).replace(".", ",")}%).`,
      });
    }
  }

  if (minProfitBrl != null && Number.isFinite(minProfitBrl) && profitSim != null) {
    const minP = new Decimal(minProfitBrl);
    if (profitSim.lt(minP)) {
      warnings.push({
        code: "below_min_profit_desired",
        severity: "medium",
        message: `Lucro simulado inferior ao mínimo desejado (R$ ${minP.toFixed(2).replace(".", ",")}).`,
      });
    }
  }

  const suggested = resCur?.break_even_price_brl != null ? String(resCur.break_even_price_brl) : null;

  const belowBreakEven = breakSim != null && candidate.lt(breakSim);
  const npOk = Boolean(npSim && /** @type {Record<string, unknown>} */ (npSim).has_valid_data === true);
  const can_apply_price = !belowBreakEven && npOk;

  return {
    ok: true,
    marketplace: ML_MARKETPLACE_SLUG,
    sale_price_candidate_brl: candidate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    current: {
      pricing_context: ctxCurrent,
      net_proceeds: npCurrent,
    },
    simulated: {
      pricing_context: ctxSim,
      net_proceeds: npSim,
    },
    comparison: {
      profit_delta_brl:
        profitDelta != null ? profitDelta.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      margin_delta_pct:
        marginDelta != null ? marginDelta.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      profit_delta_pct:
        profitDeltaPct != null ? profitDeltaPct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      profit_brl_before:
        profitCur != null ? profitCur.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      profit_brl_after:
        profitSim != null ? profitSim.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      margin_pct_before:
        marginCur != null ? marginCur.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      margin_pct_after:
        marginSim != null ? marginSim.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
    },
    suggested_price_brl: suggested,
    warnings,
    can_apply_price,
    requires_break_even_confirm: belowBreakEven,
    simulation_engine: "mercado_livre_v1",
  };
}
