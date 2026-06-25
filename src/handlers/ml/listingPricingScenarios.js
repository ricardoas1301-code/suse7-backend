// ======================================================
// POST /api/ml/listings/pricing-scenarios
// Payload: baseline + promoções do anúncio (ativas/programadas/demais), normalizadas no backend.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { buildMercadoLivreListingPricingScenariosPayload } from "../../domain/pricing/mercadoLivreListingPricingScenarios.js";

export default async function handleListingPricingScenarios(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  const listingExternalId =
    body.listingExternalId != null
      ? String(body.listingExternalId).trim()
      : body.external_listing_id != null
        ? String(body.external_listing_id).trim()
        : "";
  const listingId = body.listingId != null ? String(body.listingId).trim() : "";
  const scenarioScope =
    body.scenarioScope != null
      ? String(body.scenarioScope).trim().toLowerCase()
      : body.scenario_scope != null
        ? String(body.scenario_scope).trim().toLowerCase()
        : "";

  if (!listingExternalId && !listingId) {
    return res.status(400).json({
      ok: false,
      error: "Informe listingExternalId ou listingId.",
    });
  }

  const { user, supabase } = auth;

  const referenceZipCode =
    process.env.SUSE7_ML_PRICING_REFERENCE_ZIP?.trim() ||
    process.env.ML_PRICING_REFERENCE_ZIP?.trim() ||
    "01310100";

  let result;
  try {
    result = await buildMercadoLivreListingPricingScenariosPayload(supabase, user.id, {
      listingExternalId: listingExternalId || undefined,
      listingId: listingId || undefined,
      scenarioScope: scenarioScope || undefined,
      referenceZipCode,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ML_PRICING_SCENARIOS] unhandled_build_error", { message: msg, stack: e instanceof Error ? e.stack : undefined });
    return res.status(500).json({
      ok: false,
      error: "Não foi possível montar os cenários de precificação. Tente novamente ou sincronize o anúncio.",
    });
  }

  if (!result.ok) {
    return res.status(result.status ?? 400).json({ ok: false, error: result.error });
  }

  console.info("[pricing-rayx] pricing-scenarios built", {
    listing_external_id: listingExternalId || listingId || null,
    scenario_scope: scenarioScope || null,
    baseline_sale_price_brl: result.data?.baseline?.marketplace?.sale_price_brl ?? null,
    baseline_shipping_brl: result.data?.baseline?.marketplace?.shipping_cost_amount_brl ?? null,
    baseline_shipping_source: result.data?.baseline?.marketplace?.shipping_cost_source ?? null,
    promotion_count: Array.isArray(result.data?.promotion_scenarios)
      ? result.data.promotion_scenarios.length
      : 0,
  });

  return res.status(200).json({ ok: true, ...result.data });
}
