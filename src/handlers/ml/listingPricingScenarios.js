// ======================================================
// POST /api/ml/listings/pricing-scenarios
// Payload: baseline + promoções do anúncio (ativas/programadas/demais), normalizadas no backend.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { getValidMLToken } from "./_helpers/mlToken.js";
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

  if (!listingExternalId && !listingId) {
    return res.status(400).json({
      ok: false,
      error: "Informe listingExternalId ou listingId.",
    });
  }

  const { user, supabase } = auth;

  /** Token OAuth do usuário — frete premium via GET /items/:id/shipping_options (sem credencial em código). */
  let mlAccessToken = null;
  try {
    mlAccessToken = await getValidMLToken(user.id);
  } catch (e) {
    console.info("[ML_PRICING_SCENARIOS] ml_token_unavailable", {
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const referenceZipCode =
    process.env.SUSE7_ML_PRICING_REFERENCE_ZIP?.trim() ||
    process.env.ML_PRICING_REFERENCE_ZIP?.trim() ||
    "01310100";

  let result;
  try {
    result = await buildMercadoLivreListingPricingScenariosPayload(supabase, user.id, {
      listingExternalId: listingExternalId || undefined,
      listingId: listingId || undefined,
      mlAccessToken,
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

  return res.status(200).json({ ok: true, ...result.data });
}
