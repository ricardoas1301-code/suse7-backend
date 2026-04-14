// ======================================================
// GET /api/debug/ml/listings-cover-context?a=MLB…&b=MLB…
// Diagnóstico da CAPA no MESMO contexto de GET /api/ml/listings:
// client Supabase do utilizador autenticado (RLS), não service role.
//
// Ativo: NODE_ENV=development, VERCEL_ENV=preview|development,
// ou SUSE7_DEBUG_ML_LISTINGS_COVER_CONTEXT=1 (obrigatório em produção “fechada”).
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_LISTING_ALIASES } from "../ml/_helpers/mlMarketplace.js";
import {
  computeMercadoLibreCoverResolution,
  firstProductImageUrlFromJoin,
  normalizeMercadoLibreExternalListingId,
  parseRawJson,
  resolveGalleryImageUrlsForListing,
  resolveMercadoLibreListingCoverImageUrl,
} from "../ml/_helpers/mercadoLibreListingCoverImage.js";

function allowCoverContextDebug() {
  if (process.env.SUSE7_DEBUG_ML_LISTINGS_COVER_CONTEXT === "1") return true;
  if (process.env.NODE_ENV === "development") return true;
  const v = process.env.VERCEL_ENV;
  if (v === "development" || v === "preview") return true;
  return false;
}

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function trunc(v, max = 120) {
  if (v == null) return null;
  const s = String(v);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} externalRaw
 * @param {string} label
 */
async function buildSide(supabase, userId, externalRaw, label) {
  const normalized = normalizeMercadoLibreExternalListingId(externalRaw);
  if (!normalized) {
    return {
      label,
      error: "external_listing_id vazio ou inválido",
      external_listing_id_requested: externalRaw ?? null,
    };
  }

  const { data: row, error: rowErr } = await supabase
    .from("marketplace_listings")
    .select(
      "id, external_listing_id, raw_json, pictures_count, variations_count, product_id, marketplace, products(catalog_completeness, product_images)"
    )
    .eq("user_id", userId)
    .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
    .eq("external_listing_id", normalized)
    .maybeSingle();

  if (rowErr) {
    return {
      label,
      normalized_external_listing_id: normalized,
      error: rowErr.message || String(rowErr),
    };
  }

  if (!row) {
    return {
      label,
      normalized_external_listing_id: normalized,
      error: "Anúncio não encontrado para este utilizador (mercado_livre / mercadolivre).",
    };
  }

  const { products: prodRel, ...rest } = row;
  const product_catalog_completeness =
    prodRel && typeof prodRel === "object" && !Array.isArray(prodRel)
      ? /** @type {{ catalog_completeness?: string }} */ (prodRel).catalog_completeness ?? null
      : Array.isArray(prodRel) && prodRel[0]
        ? /** @type {{ catalog_completeness?: string }} */ (prodRel[0]).catalog_completeness ?? null
        : null;
  const product_cover_url = firstProductImageUrlFromJoin(prodRel);

  const l = { ...rest, product_catalog_completeness, product_cover_url };
  const listing = /** @type {Record<string, unknown>} */ (l);

  const { data: picRows, error: picErr } = await supabase
    .from("marketplace_listing_pictures")
    .select("listing_id, secure_url, url, position, raw_json")
    .eq("listing_id", row.id)
    .order("position", { ascending: true });

  const pictureRows = picRows || [];
  const pictureRows_count = pictureRows.length;

  const resolution = computeMercadoLibreCoverResolution({
    listing,
    pictureRows,
    productMainImageUrl: product_cover_url ?? null,
  });

  const gallery = resolveGalleryImageUrlsForListing(pictureRows, row.raw_json, 12);

  const cover_thumbnail_url_final = resolveMercadoLibreListingCoverImageUrl({
    listing,
    pictureRows,
    productMainImageUrl: product_cover_url ?? null,
  });

  const item = parseRawJson(row.raw_json);
  const picsArr = item && Array.isArray(item.pictures) ? item.pictures : null;

  return {
    label,
    external_listing_id: row.external_listing_id != null ? String(row.external_listing_id) : null,
    listing_id: row.id != null ? String(row.id) : null,
    pictures_count_column: row.pictures_count ?? null,
    variations_count: row.variations_count ?? null,
    pictureRows_count,
    pictures_query_error: picErr?.message ?? null,
    /** true quando a query não falhou mas o PostgREST devolveu 0 linhas (RLS ou realmente sem filhos). */
    pictures_query_returned_zero_rows: !picErr && pictureRows_count === 0,
    marketplace_listing_pictures_preview: pictureRows.map((p) => ({
      position: p.position ?? null,
      secure_url: trunc(p.secure_url, 140),
      url: trunc(p.url, 140),
    })),
    dbCover: resolution.dbCover || null,
    apiImage: resolution.apiImage || null,
    productCover: resolution.productCover || null,
    resolved: resolution.resolved || null,
    cover_thumbnail_url_final: cover_thumbnail_url_final || null,
    gallery_image_source: gallery.source,
    gallery_image_urls_count: gallery.urls.length,
    raw_json_pictures_array_length: picsArr ? picsArr.length : null,
    raw_json_parse_ok: item != null,
  };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleMlListingsCoverContextDebug(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  if (!allowCoverContextDebug()) {
    return res.status(403).json({
      ok: false,
      error:
        "Endpoint de diagnóstico desativado. Defina SUSE7_DEBUG_ML_LISTINGS_COVER_CONTEXT=1 ou use ambiente dev/preview.",
    });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const q = req.query || {};
  const a = q.a != null ? String(q.a).trim() : "";
  const b = q.b != null ? String(q.b).trim() : "";

  if (!a || !b) {
    return res.status(400).json({
      ok: false,
      error: "Passe dois IDs: ?a=MLB… (ex.: com capa) & b=MLB… (ex.: sem capa).",
    });
  }

  try {
    const sideA = await buildSide(supabase, user.id, a, "a (ex.: com capa)");
    const sideB = await buildSide(supabase, user.id, b, "b (ex.: sem capa)");

    return res.status(200).json({
      ok: true,
      context:
        "Mesmo Supabase client de requireAuthUser que GET /api/ml/listings (JWT + RLS). Não usa service role.",
      user_id: user.id,
      sides: { a: sideA, b: sideB },
    });
  } catch (err) {
    console.error("[debug/ml/listings-cover-context]", err);
    return res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
}
