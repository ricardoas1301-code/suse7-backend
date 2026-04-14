// ======================================================
// GET /api/debug/ml/listing-cover-compare?a=MLB…&b=MLB…
// Compara dois anúncios (sem vs com capa): payload equivalente à grid,
// raw_json.pictures e marketplace_listing_pictures — só leitura.
//
// URLs (Vercel aplica rewrite em vercel.json → também funciona com __path):
//   {API}/api/debug/ml/listing-cover-compare?a=MLB4065122155&b=MLB4064980175
//   {API}/api?__path=debug/ml/listing-cover-compare&a=MLB4065122155&b=MLB4064980175
//
// Ativo se: NODE_ENV=development, VERCEL_ENV=preview|development,
// ou SUSE7_DEBUG_ML_LISTING_COVER_COMPARE=1 (obrigatório em produção).
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  ML_MARKETPLACE_LISTING_ALIASES,
  ML_MARKETPLACE_SLUG,
} from "../ml/_helpers/mlMarketplace.js";
import {
  buildListingCoverInlineTrace,
  firstProductImageUrlFromJoin,
  normalizeMercadoLibreExternalListingId,
  parseRawJson,
  pickFirstListingPictureCoverUrl,
  resolveMercadoLibreListingCoverImageUrl,
} from "../ml/_helpers/mercadoLibreListingCoverImage.js";

function allowListingCoverCompare() {
  if (process.env.SUSE7_DEBUG_ML_LISTING_COVER_COMPARE === "1") return true;
  if (process.env.NODE_ENV === "development") return true;
  const v = process.env.VERCEL_ENV;
  if (v === "development" || v === "preview") return true;
  return false;
}

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function trunc(v, max = 140) {
  if (v == null) return null;
  const s = String(v);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} label
 * @param {string} externalRaw
 */
async function buildCompareSide(supabase, userId, label, externalRaw) {
  const normalized = normalizeMercadoLibreExternalListingId(externalRaw);
  if (!normalized) {
    return {
      label,
      external_listing_id_requested: externalRaw,
      found: false,
      error: "external_listing_id vazio ou inválido",
    };
  }

  const { data: row, error } = await supabase
    .from("marketplace_listings")
    .select(
      "id, external_listing_id, marketplace, pictures_count, raw_json, product_id, title, api_last_seen_at, products(catalog_completeness, product_images)"
    )
    .eq("user_id", userId)
    .in("marketplace", ML_MARKETPLACE_LISTING_ALIASES)
    .eq("external_listing_id", normalized)
    .maybeSingle();

  if (error) {
    return {
      label,
      external_listing_id_requested: externalRaw,
      normalized,
      found: false,
      error: error.message || String(error),
    };
  }

  if (!row) {
    return {
      label,
      external_listing_id_requested: externalRaw,
      normalized,
      found: false,
      error: "Anúncio não encontrado para este utilizador (mercado_livre / mercadolivre).",
    };
  }

  const { products: prodRel, ...rest } = row;
  const product_cover_url = firstProductImageUrlFromJoin(prodRel);
  /** @type {{ product_cover_url?: string | null }} */
  const lx = { ...rest, product_cover_url };

  const { data: picRows, error: picErr } = await supabase
    .from("marketplace_listing_pictures")
    .select("id, listing_id, external_picture_id, secure_url, url, position, raw_json")
    .eq("listing_id", row.id)
    .order("position", { ascending: true });

  if (picErr) {
    return {
      label,
      found: true,
      external_listing_id: row.external_listing_id,
      listing_id: row.id,
      error_pictures_query: picErr.message,
    };
  }

  const pictures = picRows || [];
  const dbCover = pickFirstListingPictureCoverUrl(pictures);
  const cover_thumbnail_url = resolveMercadoLibreListingCoverImageUrl({
    listing: /** @type {Record<string, unknown>} */ (lx),
    pictureRows: pictures,
    productMainImageUrl: lx.product_cover_url ?? null,
  });

  const trace = buildListingCoverInlineTrace(
    /** @type {Record<string, unknown>} */ (lx),
    lx.product_cover_url ?? null,
    cover_thumbnail_url,
    pictures
  );

  const item = parseRawJson(row.raw_json);
  const picsArr = item && Array.isArray(item.pictures) ? item.pictures : null;
  const p0 = picsArr?.[0];

  return {
    label,
    found: true,
    external_listing_id: row.external_listing_id,
    listing_id: row.id,
    marketplace: row.marketplace,
    api_last_seen_at: row.api_last_seen_at ?? null,
    product_id: row.product_id ?? null,
    /** Mesmos campos relevantes que GET /api/ml/listings (linha da grid). */
    api_grid_equivalent: {
      external_listing_id: row.external_listing_id,
      cover_thumbnail_url,
      pictures_count: row.pictures_count ?? null,
    },
    raw_json: {
      pictures_array_length: picsArr ? picsArr.length : null,
      pictures_0_type: p0 == null ? null : typeof p0,
      pictures_0_keys:
        p0 != null && typeof p0 === "object" && !Array.isArray(p0)
          ? Object.keys(p0).slice(0, 24)
          : null,
      pictures_0_secure_url_sample: trunc(p0 && typeof p0 === "object" ? p0.secure_url : null),
      pictures_0_url_sample: trunc(p0 && typeof p0 === "object" ? p0.url : null),
      thumbnail_sample: trunc(item?.thumbnail),
    },
    marketplace_listing_pictures: {
      row_count: pictures.length,
      rows: pictures.map((p) => ({
        position: p.position,
        external_picture_id: p.external_picture_id ?? null,
        secure_url_sample: trunc(p.secure_url, 160),
        url_sample: trunc(p.url, 160),
        has_secure: Boolean(p.secure_url && String(p.secure_url).trim() !== ""),
        has_url: Boolean(p.url && String(p.url).trim() !== ""),
      })),
      db_cover_resolved: dbCover || null,
    },
    _listing_cover_trace: trace,
  };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleMlListingCoverCompare(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  if (!allowListingCoverCompare()) {
    return res.status(403).json({
      ok: false,
      error:
        "Endpoint desativado. Use ambiente de desenvolvimento ou defina SUSE7_DEBUG_ML_LISTING_COVER_COMPARE=1.",
    });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const q = req.query || {};
  const a = q.a ?? q.external_id_a ?? q.id_a;
  const b = q.b ?? q.external_id_b ?? q.id_b;
  const sa = a != null ? String(a).trim() : "";
  const sb = b != null ? String(b).trim() : "";

  if (!sa || !sb) {
    return res.status(400).json({
      ok: false,
      error: "Parâmetros obrigatórios: a e b (ex.: ?a=MLB111&b=MLB222).",
      hint: "IDs do anúncio no Mercado Livre (ex.: MLB4065122155).",
    });
  }

  try {
    const [sideA, sideB] = await Promise.all([
      buildCompareSide(supabase, user.id, "a", sa),
      buildCompareSide(supabase, user.id, "b", sb),
    ]);

    return res.status(200).json({
      ok: true,
      marketplace: ML_MARKETPLACE_SLUG,
      compare: { a: sideA, b: sideB },
      usage:
        "Compare raw_json.pictures vs marketplace_listing_pictures; api_grid_equivalent.cover_thumbnail_url replica a grid.",
    });
  } catch (err) {
    console.error("[debug/ml-listing-cover-compare]", err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Erro interno",
    });
  }
}
