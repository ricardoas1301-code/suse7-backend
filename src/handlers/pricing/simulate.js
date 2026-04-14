// ======================================================
// POST /api/pricing/simulate — simulação de precificação (backend-only).
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { simulateMarketplacePricing } from "../../domain/pricing/marketplacePricingGateway.js";

export default async function handlePricingSimulate(req, res) {
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

  const listingId = body.listing_id != null ? String(body.listing_id).trim() : "";
  const salePriceCandidate =
    body.sale_price_candidate != null
      ? String(body.sale_price_candidate).trim()
      : body.sale_price != null
        ? String(body.sale_price).trim()
        : "";

  if (!listingId || !salePriceCandidate) {
    return res.status(400).json({
      ok: false,
      error: "Informe listing_id e sale_price_candidate.",
    });
  }

  const minMarginPct =
    body.min_margin_pct != null && body.min_margin_pct !== ""
      ? Number(String(body.min_margin_pct).replace(",", "."))
      : null;
  const minProfitBrl =
    body.min_profit_brl != null && body.min_profit_brl !== ""
      ? Number(String(body.min_profit_brl).replace(",", "."))
      : null;

  const marketplace =
    body.marketplace != null && String(body.marketplace).trim() !== ""
      ? String(body.marketplace).trim()
      : "mercado_livre";

  const { user, supabase } = auth;
  const result = await simulateMarketplacePricing(supabase, user.id, marketplace, {
    listing_id: listingId,
    sale_price_candidate: salePriceCandidate,
    min_margin_pct: Number.isFinite(minMarginPct) ? minMarginPct : null,
    min_profit_brl: Number.isFinite(minProfitBrl) ? minProfitBrl : null,
  });

  if (!result.ok) {
    return res.status(result.status ?? 400).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, ...result.data });
}
