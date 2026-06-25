// ======================================================
// POST /api/ml/listings/pricing-simulate-scenario
// Simula UM cenário oficial (Clássico/Premium) a partir de preço OU margem desejada.
// Recalcula comissão, frete por preço, repasse, lucro e margem reaproveitando a
// engine oficial (Anúncios / Raio-X). Sem regra financeira sensível no frontend.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import { parseExtrasPrecificacaoInteligenteFromBody } from "../../domain/pricing/aplicarExtrasPrecificacaoInteligente.js";
import { MercadoLivrePricingSimulator } from "../../domain/pricing/marketplacePricingSimulator.js";

export default async function handleListingPricingSimulateScenario(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "precificacoes" })) return;

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
  const listingId =
    body.listingId != null
      ? String(body.listingId).trim()
      : body.listing_id != null
        ? String(body.listing_id).trim()
        : "";

  if (!listingExternalId && !listingId) {
    return res.status(400).json({ ok: false, error: "Informe listingExternalId ou listingId." });
  }

  const listingTypeRaw =
    body.listingType != null
      ? String(body.listingType).trim().toLowerCase()
      : body.listing_type != null
        ? String(body.listing_type).trim().toLowerCase()
        : "";
  const listingType = listingTypeRaw === "premium" || listingTypeRaw === "gold_pro" ? "premium" : "classic";

  const salePrice =
    body.salePrice != null
      ? body.salePrice
      : body.sale_price != null
        ? body.sale_price
        : body.sale_price_candidate != null
          ? body.sale_price_candidate
          : null;
  const targetMarginPct =
    body.targetMarginPct != null
      ? body.targetMarginPct
      : body.target_margin_pct != null
        ? body.target_margin_pct
        : body.margin_pct != null
          ? body.margin_pct
          : null;

  if ((salePrice == null || String(salePrice).trim() === "") && (targetMarginPct == null || String(targetMarginPct).trim() === "")) {
    return res.status(400).json({ ok: false, error: "Informe salePrice ou targetMarginPct." });
  }

  let mlAccessToken = null;
  try {
    mlAccessToken = await getValidMLToken(user.id);
  } catch (e) {
    console.info("[ML_PRICING_SIMULATE_SCENARIO] ml_token_unavailable", {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const referenceZipCode =
    process.env.SUSE7_ML_PRICING_REFERENCE_ZIP?.trim() ||
    process.env.ML_PRICING_REFERENCE_ZIP?.trim() ||
    "01310100";

  const financialExtras = parseExtrasPrecificacaoInteligenteFromBody(body);

  let result;
  try {
    result = await MercadoLivrePricingSimulator.simulate(supabase, user.id, {
      listingExternalId: listingExternalId || undefined,
      listingId: listingId || undefined,
      listingType,
      salePrice,
      targetMarginPct,
      mlAccessToken,
      referenceZipCode,
      financialExtras,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ML_PRICING_SIMULATE_SCENARIO] unhandled_error", {
      message: msg,
      stack: e instanceof Error ? e.stack : undefined,
    });
    return res.status(500).json({
      ok: false,
      error: "Não foi possível simular o cenário. Tente novamente ou sincronize o anúncio.",
    });
  }

  if (!result.ok) {
    return res.status(result.status ?? 400).json({ ok: false, error: result.error });
  }

  const payload = result.data ?? {};
  const financial =
    payload.financial != null && typeof payload.financial === "object"
      ? payload.financial
      : null;

  return res.status(200).json({
    ok: true,
    ...payload,
    ...(financial != null ? { financial } : {}),
  });
}
