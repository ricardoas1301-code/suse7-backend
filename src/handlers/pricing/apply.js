// ======================================================
// POST /api/pricing/apply — publica preço no marketplace (ML nesta versão).
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { getValidMLToken } from "../ml/_helpers/mlToken.js";
import { applyMarketplacePrice } from "../../domain/pricing/marketplacePricingGateway.js";

export default async function handlePricingApply(req, res) {
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
  const newSalePrice =
    body.new_sale_price != null
      ? String(body.new_sale_price).trim()
      : body.sale_price != null
        ? String(body.sale_price).trim()
        : "";

  if (!listingId || !newSalePrice) {
    return res.status(400).json({ ok: false, error: "Informe listing_id e new_sale_price." });
  }

  const marketplace =
    body.marketplace != null && String(body.marketplace).trim() !== ""
      ? String(body.marketplace).trim()
      : "mercado_livre";

  const { user, supabase } = auth;

  let token;
  try {
    token = await getValidMLToken(user.id);
  } catch (e) {
    console.error("[pricing/apply] ml_token", e?.message);
    return res.status(401).json({
      ok: false,
      error:
        e?.message != null
          ? String(e.message)
          : "Não foi possível obter token do Mercado Livre. Reconecte em Integrações.",
    });
  }

  const result = await applyMarketplacePrice(supabase, user.id, token, marketplace, {
    listing_id: listingId,
    new_sale_price: newSalePrice,
  });

  if (!result.ok) {
    return res.status(result.status ?? 502).json({
      ok: false,
      error: result.error,
      warnings: result.warnings ?? undefined,
      ml_body: result.ml_body ?? undefined,
    });
  }

  return res.status(200).json({ ok: true, ...result.data });
}
