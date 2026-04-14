#!/usr/bin/env node
// ======================================================================
// Diagnóstico: capa do anúncio (persistência vs join vs resolução).
// Uso (na raiz do backend, com .env carregado):
//   node scripts/diag-listing-cover.mjs <uuid_listing_1> [uuid_listing_2] ...
//
// Compara marketplace_listings + marketplace_listing_pictures + products
// + product_image_links e imprime a mesma URL que resolveMercadoLibreListingCoverImageUrl.
// ======================================================================

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  firstProductImageUrlFromJoin,
  parseRawJson,
  resolveDbCoverFromPicturesRows,
  resolveMercadoLibreListingCoverImageUrl,
} from "../src/handlers/ml/_helpers/mercadoLibreListingCoverImage.js";

const url = process.env.SUPABASE_URL || "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const ids = process.argv.slice(2).filter(Boolean);
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env");
  process.exit(1);
}
if (ids.length === 0) {
  console.error(
    "Passe pelo menos um UUID de marketplace_listings.id, ex.:\n" +
      "  node scripts/diag-listing-cover.mjs 1a628314-d952-460b-9fb3-5201d64965b2 ..."
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

function summarizeRawJsonPictures(raw) {
  const item = parseRawJson(raw);
  if (!item) return { hasRaw: false };
  const pics = Array.isArray(item.pictures) ? item.pictures : [];
  const p0 = pics[0] && typeof pics[0] === "object" ? /** @type {Record<string, unknown>} */ (pics[0]) : null;
  return {
    hasRaw: true,
    picturesLength: pics.length,
    p0_secure_url: p0?.secure_url != null ? String(p0.secure_url).slice(0, 120) : null,
    p0_url: p0?.url != null ? String(p0.url).slice(0, 120) : null,
    thumbnail: item.thumbnail != null ? String(item.thumbnail).slice(0, 120) : null,
  };
}

for (const listingId of ids) {
  console.log("\n========== listing_id:", listingId, "==========");

  const { data: row, error: rowErr } = await supabase
    .from("marketplace_listings")
    .select(
      "id, user_id, marketplace, external_listing_id, title, product_id, pictures_count, raw_json"
    )
    .eq("id", listingId)
    .maybeSingle();

  if (rowErr) {
    console.log("ERRO marketplace_listings:", rowErr.message);
    continue;
  }
  if (!row) {
    console.log("marketplace_listings: (nenhuma linha com este id)");
    continue;
  }

  console.log("— marketplace_listings —");
  console.log({
    id: row.id,
    user_id: row.user_id,
    marketplace: row.marketplace,
    external_listing_id: row.external_listing_id,
    title: row.title != null ? String(row.title).slice(0, 80) : null,
    product_id: row.product_id,
    pictures_count: row.pictures_count,
    raw_json_summary: summarizeRawJsonPictures(row.raw_json),
  });

  const { data: picRows, error: picErr } = await supabase
    .from("marketplace_listing_pictures")
    .select("listing_id, position, url, secure_url, external_picture_id")
    .eq("listing_id", listingId)
    .order("position", { ascending: true });

  if (picErr) console.log("ERRO marketplace_listing_pictures:", picErr.message);
  console.log("— marketplace_listing_pictures — count:", (picRows || []).length);
  for (const p of picRows || []) {
    console.log({
      position: p.position,
      secure_url: p.secure_url != null ? String(p.secure_url).slice(0, 100) : null,
      url: p.url != null ? String(p.url).slice(0, 100) : null,
      external_picture_id: p.external_picture_id,
    });
  }

  const dbCover = resolveDbCoverFromPicturesRows(picRows || []);

  let productRow = null;
  /** @type {unknown[]} */
  let linkRows = [];
  if (row.product_id) {
    const { data: pr, error: pErr } = await supabase
      .from("products")
      .select("id, user_id, product_images")
      .eq("id", row.product_id)
      .maybeSingle();
    if (pErr) console.log("ERRO products:", pErr.message);
    productRow = pr;
    console.log("— products —");
    const pi = pr?.product_images;
    const piPreview = Array.isArray(pi) && pi[0] ? pi[0] : null;
    console.log({
      id: pr?.id,
      user_id: pr?.user_id,
      product_images_length: Array.isArray(pi) ? pi.length : null,
      product_images_0: piPreview,
    });

    const { data: links, error: lErr } = await supabase
      .from("product_image_links")
      .select("id, product_id, position, url, public_url, listing_id")
      .eq("product_id", row.product_id)
      .order("position", { ascending: true });
    if (lErr) console.log("ERRO product_image_links:", lErr.message);
    linkRows = links || [];
    console.log("— product_image_links — count:", linkRows.length);
    for (const l of linkRows.slice(0, 5)) {
      console.log({
        position: l.position,
        url: l.url != null ? String(l.url).slice(0, 80) : null,
        public_url: l.public_url != null ? String(l.public_url).slice(0, 80) : null,
        listing_id: l.listing_id,
      });
    }
  } else {
    console.log("— products — (sem product_id)");
    console.log("— product_image_links — (sem produto)");
  }

  const productJoinSim = productRow ? [productRow] : null;
  const productCoverUrl = firstProductImageUrlFromJoin(productJoinSim);

  const resolved = resolveMercadoLibreListingCoverImageUrl({
    listing: /** @type {Record<string, unknown>} */ (row),
    pictureRows: picRows || [],
    productMainImageUrl: productCoverUrl,
  });

  console.log("— resolução (igual ao GET /api/ml/listings) —");
  console.log({
    dbCover_from_table: dbCover,
    product_cover_from_product_images: productCoverUrl,
    cover_thumbnail_url_final: resolved,
    cover_image_url_final: resolved,
  });

  /** @type {string[]} */
  const layers = [];
  if (resolved) layers.push("helper resolveu URL (raw_json e/ou DB e/ou product_images)");
  else {
    if (!summarizeRawJsonPictures(row.raw_json).hasRaw) layers.push("raw_json ausente ou inválido (sem pictures/thumbnail na memória)");
    else {
      const s = summarizeRawJsonPictures(row.raw_json);
      if (!s.p0_secure_url && !s.p0_url && !s.thumbnail && s.picturesLength === 0)
        layers.push("raw_json sem pictures[] nem thumbnail");
      else if (!s.p0_secure_url && !s.p0_url?.startsWith("https") && !s.thumbnail)
        layers.push("raw_json sem URLs utilizáveis nas regras atuais");
    }
    if (!(picRows || []).length || !dbCover) layers.push("marketplace_listing_pictures vazia ou sem url/secure_url");
    if (!row.product_id) layers.push("sem product_id → sem fallback product_images");
    else if (!productCoverUrl) layers.push("product sem product_images[0].url útil");
  }
  if (!resolved) console.log("hipótese de falha:", layers.join(" | "));
}

console.log("\n(fim)");
