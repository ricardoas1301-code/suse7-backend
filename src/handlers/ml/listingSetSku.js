// POST /api/ml/listings/set-sku — fluxo individual sobre o serviço canônico.

import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { ATTENTION_REASON_SKU_PENDING_ML } from "./_helpers/mlItemSkuExtract.js";
import { createOrLinkListingSku } from "../listings/createOrLinkListingSkuService.js";

export default async function handleMlListingSetSku(req, res) {
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

  const listingId = String(body.listing_id || "").trim();
  if (!listingId) return res.status(400).json({ ok: false, error: "Informe listing_id." });

  const { user, supabase } = auth;
  const { data: row, error } = await supabase
    .from("marketplace_listings")
    .select(
      "id, user_id, marketplace, raw_json, external_listing_id, seller_sku, seller_custom_field, title, price, attention_reason",
    )
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !row) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  const result = await createOrLinkListingSku({
    supabase,
    userId: user.id,
    row,
    skuRaw: body.seller_sku,
    selectedProductId: body.selected_product_id,
    auditReason: "set_sku",
  });
  if (!result.ok) {
    return res.status(result.status || 422).json({
      ok: false,
      error: result.message,
      code: result.code,
      ...(result.candidate_product_ids
        ? { candidate_product_ids: result.candidate_product_ids }
        : {}),
      ...(result.product_link ? { product_link: result.product_link } : {}),
    });
  }

  return res.status(200).json({
    ok: true,
    message: "SKU confirmado e produto vinculado.",
    product_link: result,
    attention_cleared: true,
    previous_attention: ATTENTION_REASON_SKU_PENDING_ML,
  });
}
