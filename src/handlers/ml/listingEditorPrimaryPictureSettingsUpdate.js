import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import {
  listingPictureStableKey,
  normalizarListingPictures,
  normalizarOrderedPictureKeys,
} from "../../domain/listings/images/listingPictureKeys.js";
import { salvarListingPrimaryPictureSettings } from "./_helpers/listingEditor/listingPrimaryPictureSettingsStore.js";

/**
 * @param {unknown} value
 */
function textoOuVazio(value) {
  return value != null ? String(value).trim() : "";
}

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  const text = textoOuVazio(value);
  return text !== "" ? text : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} listingId
 */
async function carregarPicturesDoListing(supabase, listingId, listingRow) {
  const { data: pictureRows } = await supabase
    .from("marketplace_listing_pictures")
    .select("secure_url, url, position, raw_json")
    .eq("listing_id", listingId)
    .order("position", { ascending: true });

  const rawItem =
    listingRow.raw_json && typeof listingRow.raw_json === "object" && !Array.isArray(listingRow.raw_json)
      ? /** @type {Record<string, unknown>} */ (listingRow.raw_json)
      : {};

  const picturesFromDb = Array.isArray(pictureRows)
    ? pictureRows.map((p, index) => {
        const row = p && typeof p === "object" ? /** @type {Record<string, unknown>} */ (p) : {};
        const rawJson =
          row.raw_json && typeof row.raw_json === "object" && !Array.isArray(row.raw_json)
            ? /** @type {Record<string, unknown>} */ (row.raw_json)
            : {};
        return {
          picture_id: textoOuNull(rawJson.id),
          url: textoOuNull(row.secure_url) ?? textoOuNull(row.url),
          position: Number(row.position ?? index),
        };
      })
    : [];

  const picturesFromRaw = Array.isArray(rawItem.pictures)
    ? rawItem.pictures
        .filter((p) => p && typeof p === "object")
        .map((p, index) => {
          const row = /** @type {Record<string, unknown>} */ (p);
          return {
            picture_id: textoOuNull(row.id),
            url: textoOuNull(row.secure_url) ?? textoOuNull(row.url),
            position: Number(row.position ?? index),
          };
        })
    : [];

  return normalizarListingPictures(picturesFromDb.length > 0 ? picturesFromDb : picturesFromRaw);
}

export default async function handleListingEditorPrimaryPictureSettingsUpdate(req, res) {
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

  const listingId = textoOuVazio(body.listing_id ?? body.listingId);
  if (!listingId) {
    return res.status(400).json({ ok: false, error: "Informe listing_id." });
  }

  const orderedPictureKeys = normalizarOrderedPictureKeys(
    body.ordered_picture_keys ?? body.orderedPictureKeys,
  );

  if (orderedPictureKeys.length === 0) {
    return res.status(400).json({ ok: false, error: "Informe a ordem das imagens do anúncio." });
  }

  const { user, supabase } = auth;
  const { data: listingRow, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id, raw_json")
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (listingErr || !listingRow) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  const pictures = await carregarPicturesDoListing(supabase, listingId, listingRow);
  if (pictures.length === 0) {
    return res.status(422).json({ ok: false, error: "Este anúncio não possui imagens para ordenar." });
  }

  const byKey = new Map(pictures.map((pic) => [pic.stable_key, pic]));
  const uniqueKeys = [...new Set(orderedPictureKeys)];

  if (uniqueKeys.length !== pictures.length || uniqueKeys.length !== orderedPictureKeys.length) {
    return res.status(422).json({
      ok: false,
      error: "A ordem informada deve incluir todas as imagens do anúncio, sem duplicatas.",
    });
  }

  const orderedPictures = orderedPictureKeys.map((key) => byKey.get(key) ?? null);
  if (orderedPictures.some((pic) => pic == null)) {
    return res.status(422).json({
      ok: false,
      error: "A ordem informada contém imagens que não pertencem a este anúncio.",
    });
  }

  const first = orderedPictures[0];
  const saveResult = await salvarListingPrimaryPictureSettings(supabase, user.id, listingId, {
    primaryPictureId: first?.picture_id ?? null,
    primaryPictureUrl: first?.url ?? null,
    orderedPictureKeys,
  });

  if (!saveResult.ok) {
    return res.status(500).json({
      ok: false,
      error: "Não foi possível salvar a ordem das imagens deste anúncio.",
    });
  }

  return res.status(200).json({
    ok: true,
    listing_id: listingId,
    primary_picture_settings: {
      primary_picture_id: first?.picture_id ?? null,
      primary_picture_url: first?.url ?? null,
      primary_picture_key: first?.stable_key ?? listingPictureStableKey(first ?? {}),
      ordered_picture_keys: orderedPictureKeys,
      updated_at: saveResult.updated_at,
      persistence_source: saveResult.source,
    },
  });
}
