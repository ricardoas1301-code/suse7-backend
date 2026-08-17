import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { numeroMedidaOuNull } from "../../domain/listings/measurements/buildListingMeasurementsSummary.js";
import { salvarListingLocalMeasurementSettings } from "./_helpers/listingEditor/listingLocalMeasurementSettingsStore.js";

/**
 * @param {unknown} value
 */
function textoOuVazio(value) {
  return value != null ? String(value) : "";
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} flatKey
 * @param {string} blockKey
 * @param {string} nestedKey
 */
function lerCampoMedida(body, flatKey, blockKey, nestedKey) {
  if (body[flatKey] !== undefined) return body[flatKey];
  const block =
    body[blockKey] && typeof body[blockKey] === "object"
      ? /** @type {Record<string, unknown>} */ (body[blockKey])
      : null;
  if (block && block[nestedKey] !== undefined) return block[nestedKey];
  return undefined;
}

export default async function handleListingEditorMeasurementSettingsUpdate(req, res) {
  if (req.method !== "PUT" && req.method !== "PATCH" && req.method !== "POST") {
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

  const listingId = textoOuVazio(body.listing_id ?? body.listingId).trim();
  if (!listingId) {
    return res.status(400).json({ ok: false, error: "Informe listing_id." });
  }

  const payload = {
    shipping_width_cm: numeroMedidaOuNull(lerCampoMedida(body, "shipping_width_cm", "shipping", "width_cm")),
    shipping_height_cm: numeroMedidaOuNull(lerCampoMedida(body, "shipping_height_cm", "shipping", "height_cm")),
    shipping_length_cm: numeroMedidaOuNull(lerCampoMedida(body, "shipping_length_cm", "shipping", "length_cm")),
    shipping_weight_kg: numeroMedidaOuNull(lerCampoMedida(body, "shipping_weight_kg", "shipping", "weight_kg")),
    product_width_cm: numeroMedidaOuNull(lerCampoMedida(body, "product_width_cm", "product_mounted", "width_cm")),
    product_height_cm: numeroMedidaOuNull(lerCampoMedida(body, "product_height_cm", "product_mounted", "height_cm")),
    product_length_cm: numeroMedidaOuNull(lerCampoMedida(body, "product_length_cm", "product_mounted", "length_cm")),
    product_weight_kg: numeroMedidaOuNull(lerCampoMedida(body, "product_weight_kg", "product_mounted", "weight_kg")),
  };

  const { user, supabase } = auth;
  const { data: listingRow, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id")
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (listingErr || !listingRow) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  const saveResult = await salvarListingLocalMeasurementSettings(supabase, user.id, listingId, payload);

  if (!saveResult.ok) {
    return res.status(500).json({
      ok: false,
      error: "Não foi possível salvar as medidas deste anúncio.",
    });
  }

  return res.status(200).json({
    ok: true,
    listing_id: listingId,
    measurement_settings: {
      ...payload,
      source: "local_override",
      updated_at: saveResult.updated_at,
      persistence_source: saveResult.source,
    },
  });
}
