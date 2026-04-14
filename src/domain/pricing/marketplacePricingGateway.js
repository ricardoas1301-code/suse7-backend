// ======================================================
// Porta de entrada multi-marketplace — simular / aplicar preço.
// Hoje: delegação explícita para Mercado Livre; novos canais = nova strategy.
// ======================================================

import Decimal from "decimal.js";
import {
  loadMercadoLivreListingPricingInputs,
  runMercadoLivrePricingSimulation,
} from "../../handlers/pricing/_helpers/mercadoLivrePricingSimulation.js";
import { ML_MARKETPLACE_SLUG } from "../../handlers/ml/_helpers/mlMarketplace.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {{ listing_id: string; sale_price_candidate: string; min_margin_pct?: number | null; min_profit_brl?: number | null }} payload
 */
export async function simulateMarketplacePricing(supabase, userId, marketplace, payload) {
  const m = String(marketplace || "").trim();
  if (m !== ML_MARKETPLACE_SLUG && m !== "mercadolivre") {
    return { ok: false, error: "Marketplace não suportado para simulação.", status: 400 };
  }

  const bundle = await loadMercadoLivreListingPricingInputs(supabase, userId, payload.listing_id);
  if (!bundle.ok) {
    return { ok: false, error: bundle.error, status: bundle.status ?? 400 };
  }

  const out = runMercadoLivrePricingSimulation({
    listing: bundle.listing,
    health: bundle.health,
    metrics: bundle.metrics,
    sellerTaxPct: bundle.sellerTaxPct,
    salePriceCandidateStr: payload.sale_price_candidate,
    minMarginPct: payload.min_margin_pct ?? null,
    minProfitBrl: payload.min_profit_brl ?? null,
  });

  if (!out.ok) {
    return { ok: false, error: out.error, status: 400 };
  }

  const { ok: _stripOk, ...simPayload } = out;
  return {
    ok: true,
    data: {
      ...simPayload,
      listing_id: payload.listing_id,
      external_listing_id: bundle.external_listing_id,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} accessTokenMl
 * @param {string} marketplace
 * @param {{ listing_id: string; new_sale_price: string }} payload
 */
export async function applyMarketplacePrice(supabase, userId, accessTokenMl, marketplace, payload) {
  const m = String(marketplace || "").trim();
  if (m !== ML_MARKETPLACE_SLUG && m !== "mercadolivre") {
    return { ok: false, error: "Marketplace não suportado para aplicar preço.", status: 400 };
  }

  const bundle = await loadMercadoLivreListingPricingInputs(supabase, userId, payload.listing_id);
  if (!bundle.ok) {
    return { ok: false, error: bundle.error, status: bundle.status ?? 404 };
  }

  const ext = bundle.external_listing_id;
  if (!ext) {
    return { ok: false, error: "Anúncio sem ID externo do marketplace.", status: 400 };
  }

  const { putMercadoLibreItemPrice, fetchItem } = await import(
    "../../handlers/ml/_helpers/mercadoLibreItemsApi.js"
  );
  const { persistMercadoLibreListing } = await import("../../handlers/ml/_helpers/mlListingsPersist.js");
  const { createListingSnapshot } = await import("../../handlers/ml/_helpers/listingSnapshots.js");

  let priceDec;
  try {
    priceDec = new Decimal(String(payload.new_sale_price ?? "").trim().replace(",", "."));
  } catch {
    priceDec = null;
  }
  if (!priceDec || !priceDec.isFinite() || priceDec.lte(0)) {
    return { ok: false, error: "Preço inválido.", status: 400 };
  }

  const preCheck = runMercadoLivrePricingSimulation({
    listing: bundle.listing,
    health: bundle.health,
    metrics: bundle.metrics,
    sellerTaxPct: bundle.sellerTaxPct,
    salePriceCandidateStr: priceDec.toFixed(2),
    minMarginPct: null,
    minProfitBrl: null,
  });
  if (!preCheck.ok) {
    return { ok: false, error: preCheck.error ?? "Simulação inválida.", status: 400 };
  }
  if (!preCheck.can_apply_price) {
    return {
      ok: false,
      error:
        "Não é possível aplicar este preço: abaixo do piso saudável ou repasse insuficiente. Ajuste e simule novamente.",
      status: 409,
      warnings: preCheck.warnings,
    };
  }

  try {
    const updated = await putMercadoLibreItemPrice(accessTokenMl, ext, priceDec.toNumber());
    const fresh = await fetchItem(accessTokenMl, ext);
    if (fresh && typeof fresh === "object") {
      await persistMercadoLibreListing(supabase, userId, fresh, null, {
        accessToken: accessTokenMl,
        syncReason: "pricing_apply",
      });
    }
    await createListingSnapshot(supabase, {
      userId,
      listingId: payload.listing_id,
      marketplace: ML_MARKETPLACE_SLUG,
      capturedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      data: {
        marketplace: ML_MARKETPLACE_SLUG,
        listing_id: payload.listing_id,
        external_listing_id: ext,
        price_applied: priceDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        applied_at: new Date().toISOString(),
        ml_item_snapshot: { id: updated?.id ?? null, price: updated?.price ?? null },
      },
    };
  } catch (e) {
    const status = /** @type {any} */ (e)?.status;
    const msg = e?.message != null ? String(e.message) : "Falha ao atualizar preço no Mercado Livre.";
    console.error("[pricing/apply] ml_error", { ext, msg, status });
    return {
      ok: false,
      error: msg,
      status: Number.isFinite(status) && status >= 400 && status < 600 ? status : 502,
      ml_body: /** @type {any} */ (e)?.body ?? null,
    };
  }
}
