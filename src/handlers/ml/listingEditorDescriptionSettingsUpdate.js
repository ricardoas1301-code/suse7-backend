import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { salvarListingLocalDescriptionSettings } from "./_helpers/listingEditor/listingLocalDescriptionSettingsStore.js";

/**
 * @param {unknown} value
 */
function textoOuVazio(value) {
  return value != null ? String(value) : "";
}

export default async function handleListingEditorDescriptionSettingsUpdate(req, res) {
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

  const descriptionText = textoOuVazio(body.description_text ?? body.descriptionText ?? body.description);

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

  const saveResult = await salvarListingLocalDescriptionSettings(supabase, user.id, listingId, {
    descriptionText,
  });

  if (!saveResult.ok) {
    return res.status(500).json({
      ok: false,
      error: "Não foi possível salvar a descrição deste anúncio.",
    });
  }

  return res.status(200).json({
    ok: true,
    listing_id: listingId,
    description_settings: {
      description_text: descriptionText,
      source: "local_override",
      updated_at: saveResult.updated_at,
      persistence_source: saveResult.source,
    },
  });
}
