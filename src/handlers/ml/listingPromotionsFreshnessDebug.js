// ======================================================
// GET /api/ml/listings/:listingId/promotions/debug?fresh=1
// Side-by-side: live ML, snapshot DB e promotion_card_contract (Modal PI).
// fresh=1 força busca live; não persiste automaticamente.
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { buildMercadoLivreListingPromotionsFreshnessDebug } from "../../domain/pricing/mercadoLivrePromotionSsotFreshnessAudit.js";

function parseFreshFlag(req) {
  const q = req.query ?? {};
  const raw =
    q.fresh ??
    q.forceFresh ??
    (req.url != null && String(req.url).includes("fresh=1") ? "1" : null);
  if (raw == null) return true;
  const s = String(raw).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export default async function handleListingPromotionsFreshnessDebug(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const listingId =
    req.params?.listingId != null
      ? String(req.params.listingId).trim()
      : req.params?.listing_id != null
        ? String(req.params.listing_id).trim()
        : "";

  if (!listingId) {
    return res.status(400).json({ ok: false, error: "Informe listingId na URL." });
  }

  const forceFresh = parseFreshFlag(req);
  const referenceZipCode =
    process.env.SUSE7_ML_PRICING_REFERENCE_ZIP?.trim() ||
    process.env.ML_PRICING_REFERENCE_ZIP?.trim() ||
    "01310100";

  const { user, supabase } = auth;

  let result;
  try {
    result = await buildMercadoLivreListingPromotionsFreshnessDebug(supabase, user.id, {
      listingExternalId: listingId.toUpperCase().startsWith("MLB") ? listingId : undefined,
      listingId: listingId.toUpperCase().startsWith("MLB") ? undefined : listingId,
      forceFresh,
      referenceZipCode,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ML_PROMOTIONS_FRESHNESS_DEBUG] unhandled_error", {
      listing_id: listingId,
      message: msg,
    });
    return res.status(500).json({
      ok: false,
      error: "Não foi possível montar o debug de freshness das promoções.",
    });
  }

  if (!result.ok) {
    return res.status(result.status ?? 400).json({ ok: false, error: result.error });
  }

  return res.status(200).json({
    ok: true,
    route: "GET /api/ml/listings/:listingId/promotions/debug",
    fresh: forceFresh,
    ...result,
  });
}
