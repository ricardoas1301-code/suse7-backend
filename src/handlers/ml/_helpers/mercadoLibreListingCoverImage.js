// ======================================================
// Capa do anúncio (grid) — Mercado Livre.
// Prioridade: marketplace_listing_pictures → raw_json (item) → product_images.
// Só leitura; não altera persistência.
// ======================================================

/** Usado quando `position` é ausente ou não numérico — ordenação ASC (capa = menor índice). */
const DB_PICTURE_POSITION_FALLBACK = 999999;

/** IDs com trace embutido em GET /api/ml/listings + log do resolver — temporário. */
export const LISTING_COVER_INLINE_TRACE_IDS = new Set([
  "MLB5746345442",
  "MLB4060921153",
  "MLB4065122155",
  "MLB4064980175",
]);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeHttpUrl(value) {
  if (value == null) return null;
  let s;
  if (typeof value === "string") {
    s = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    s = String(value);
  } else {
    return null;
  }
  const trimmed = s.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (!trimmed) return null;
  if (trimmed === "[object Object]" || trimmed === "null" || trimmed === "undefined") return null;
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    return trimmed;
  }
  return null;
}

/**
 * ML envia muitas vezes `pictures[]` com `secure_url`/`url` só dentro de `variations[]`, ou só `id`.
 * @param {unknown} po — objeto picture do item ou recurso GET /pictures/:id
 * @returns {string | null}
 */
export function extractMlPictureHttpFromObject(po) {
  if (!po || typeof po !== "object" || Array.isArray(po)) return null;
  const o = /** @type {Record<string, unknown>} */ (po);
  let u = normalizeHttpUrl(o.secure_url) || normalizeHttpUrl(o.url);
  if (u) return u;
  const vars = o.variations;
  if (Array.isArray(vars)) {
    for (const v of vars) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const vo = /** @type {Record<string, unknown>} */ (v);
      u = normalizeHttpUrl(vo.secure_url) || normalizeHttpUrl(vo.url);
      if (u) return u;
    }
  }
  return null;
}

/**
 * @param {unknown} rows
 * @returns {string | null}
 */
export function resolveDbCoverFromPicturesRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const sorted = [...rows].sort((a, b) => {
    const pa =
      a != null && a.position != null && Number.isFinite(Number(a.position))
        ? Number(a.position)
        : DB_PICTURE_POSITION_FALLBACK;
    const pb =
      b != null && b.position != null && Number.isFinite(Number(b.position))
        ? Number(b.position)
        : DB_PICTURE_POSITION_FALLBACK;
    return pa - pb;
  });

  for (const row of sorted) {
    let candidate =
      row && typeof row === "object" && !Array.isArray(row)
        ? extractMlPictureHttpFromObject(row)
        : null;
    if (!candidate && row && typeof row === "object" && !Array.isArray(row)) {
      const rj = /** @type {{ raw_json?: unknown }} */ (row).raw_json;
      candidate = extractMlPictureHttpFromObject(rj);
    }
    if (candidate) return candidate;
  }

  return null;
}

/**
 * Lista de URLs HTTP(S) para diagnóstico (galeria) — mesma ordem/linhas que `resolveDbCoverFromPicturesRows`, até `max` entradas.
 * @param {unknown[]} rows
 * @param {number} [max]
 * @returns {string[]}
 */
export function pictureRowsToGalleryUrls(rows, max = 12) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => {
    const pa =
      a != null && /** @type {{ position?: unknown }} */ (a).position != null && Number.isFinite(Number(/** @type {{ position?: unknown }} */ (a).position))
        ? Number(/** @type {{ position?: unknown }} */ (a).position)
        : DB_PICTURE_POSITION_FALLBACK;
    const pb =
      b != null && /** @type {{ position?: unknown }} */ (b).position != null && Number.isFinite(Number(/** @type {{ position?: unknown }} */ (b).position))
        ? Number(/** @type {{ position?: unknown }} */ (b).position)
        : DB_PICTURE_POSITION_FALLBACK;
    return pa - pb;
  });
  /** @type {string[]} */
  const out = [];
  for (const row of sorted) {
    if (out.length >= max) break;
    let u =
      row && typeof row === "object" && !Array.isArray(row) ? extractMlPictureHttpFromObject(row) : null;
    if (!u && row && typeof row === "object" && !Array.isArray(row)) {
      u = extractMlPictureHttpFromObject(/** @type {{ raw_json?: unknown }} */ (row).raw_json);
    }
    if (u) out.push(u);
  }
  return out;
}

/**
 * Primeira URL utilizável no snapshot do item ML (GET /items): `pictures[]` (secure_url → url), depois `thumbnail`.
 * @param {Record<string, unknown> | null} item
 * @returns {string | null}
 */
export function resolveApiCoverFromRawJson(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;

  const pictures = Array.isArray(item.pictures) ? item.pictures : [];

  for (const pic of pictures) {
    if (!pic || typeof pic !== "object" || Array.isArray(pic)) continue;
    const candidate = extractMlPictureHttpFromObject(pic);
    if (candidate) return candidate;
  }

  return normalizeHttpUrl(item.thumbnail);
}

/**
 * Todas as URLs HTTP(S) utilizáveis em `item.pictures` (ordem do array), até `max`.
 * Usado na galeria de diagnóstico quando `marketplace_listing_pictures` está vazio ou sem URL válida.
 * @param {Record<string, unknown> | null} item
 * @param {number} [max]
 * @returns {string[]}
 */
export function pictureUrlsFromRawJsonItem(item, max = 12) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const pictures = Array.isArray(item.pictures) ? item.pictures : [];
  /** @type {string[]} */
  const out = [];
  for (const pic of pictures) {
    if (out.length >= max) break;
    if (!pic || typeof pic !== "object" || Array.isArray(pic)) continue;
    const u = extractMlPictureHttpFromObject(pic);
    if (u) out.push(u);
  }
  return out;
}

/**
 * Galeria para API: prioriza URLs persistidas em `marketplace_listing_pictures`; se vazio, usa `raw_json` do item.
 * @param {unknown[]} pictureRows
 * @param {unknown} rawJson
 * @param {number} [max]
 * @returns {{ urls: string[]; source: "marketplace_listing_pictures" | "raw_json.pictures" | "none" }}
 */
export function resolveGalleryImageUrlsForListing(pictureRows, rawJson, max = 12) {
  const fromDb = pictureRowsToGalleryUrls(pictureRows, max);
  if (fromDb.length > 0) {
    return { urls: fromDb, source: "marketplace_listing_pictures" };
  }
  const item = parseRawJson(rawJson);
  const fromRaw = pictureUrlsFromRawJsonItem(item, max);
  if (fromRaw.length > 0) {
    return { urls: fromRaw, source: "raw_json.pictures" };
  }
  return { urls: [], source: "none" };
}

/** @deprecated use resolveDbCoverFromPicturesRows — alias para chamadas antigas */
export const pickFirstListingPictureCoverUrl = resolveDbCoverFromPicturesRows;

/**
 * raw_json como objeto (PostgREST) ou string JSON — com parse duplo se vier embutido.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function parseRawJson(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw);
  }
  if (typeof raw === "string") {
    try {
      let o = JSON.parse(raw);
      if (typeof o === "string") {
        try {
          o = JSON.parse(o);
        } catch {
          return null;
        }
      }
      if (o && typeof o === "object" && !Array.isArray(o)) {
        return /** @type {Record<string, unknown>} */ (o);
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Compara IDs ML (DB pode vir só com dígitos).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMercadoLibreExternalListingId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const u = s.toUpperCase();
  if (u.startsWith("MLB")) return u;
  if (/^\d+$/.test(s)) return `MLB${s}`;
  return u;
}

/**
 * @param {Record<string, unknown> | null | undefined} listing
 * @param {string | null} dbCover
 * @param {string | null} productCover
 * @param {Record<string, unknown> | null} item
 * @param {string | null} apiImage
 * @param {string | null} resolved
 */
export function buildListingCoverDebugPayload(listing, dbCover, productCover, item, apiImage, resolved) {
  const extId = listing?.external_listing_id != null ? String(listing.external_listing_id).trim() : "";
  const raw = listing?.raw_json;
  const pics = item && Array.isArray(item.pictures) ? item.pictures : null;
  const p0 = pics?.[0];

  const hasFinal = resolved != null && resolved !== "";
  let cover_zeroed_by = null;
  if (!hasFinal) {
    if (!item) cover_zeroed_by = "parseRawJson";
    else cover_zeroed_by = "no_usable_http_url_in_db_api_or_product";
  }

  return {
    external_listing_id: extId,
    pictures_count_column: listing?.pictures_count ?? null,
    typeof_raw_json: raw === null || raw === undefined ? String(raw) : typeof raw,
    raw_json_exists: raw !== null && raw !== undefined && raw !== "",
    parseRawJson_ok: item != null,
    dbCover: dbCover || null,
    apiRaw: null,
    apiImage: apiImage || null,
    product_cover_url: productCover || null,
    resolved: resolved || null,
    pictures_array_len: pics?.length ?? null,
    pictures_0_type: p0 == null ? "null" : typeof p0,
    pictures_0_keys:
      p0 != null && typeof p0 === "object" && !Array.isArray(p0) ? Object.keys(p0).slice(0, 12) : null,
    loss_hint:
      item == null
        ? "parseRawJson_null_check_typeof_raw_json"
        : !Array.isArray(item.pictures) || item.pictures.length === 0
          ? "item.pictures_missing_or_empty"
          : !apiImage
            ? "pictures_no_usable_secure_url_or_url_or_thumbnail"
            : null,
    cover_zeroed_by,
  };
}

/**
 * @param {{ listing: Record<string, unknown>; pictureRows: Array<unknown>; productMainImageUrl: unknown }}
 * @returns {{ dbCover: string | null; apiImage: string | null; productCover: string | null; resolved: string | null; item: Record<string, unknown> | null }}
 */
export function computeMercadoLibreCoverResolution({ listing, pictureRows, productMainImageUrl }) {
  const rows = Array.isArray(pictureRows) ? pictureRows : [];
  const dbCover = resolveDbCoverFromPicturesRows(rows);

  const item = parseRawJson(listing?.raw_json);
  const apiImage = resolveApiCoverFromRawJson(item);

  const productCover = normalizeHttpUrl(productMainImageUrl);

  const resolved = dbCover || apiImage || productCover || null;

  return {
    dbCover,
    apiImage,
    productCover,
    item,
    resolved: resolved || null,
  };
}

/**
 * URL de capa para a grid (GET /api/ml/listings).
 * Prioridade: `dbCover` (marketplace_listing_pictures) → `apiImage` (raw_json) → `productCover`.
 *
 * Log temporário (IDs em LISTING_COVER_INLINE_TRACE_IDS ou `SUSE7_LOG_LISTING_COVER_RESOLVER=1`):
 * external_listing_id, pictureRows length, dbCover, apiImage, productCover, resolved.
 *
 * @param {{ listing: Record<string, unknown>; pictureRows?: unknown[]; productMainImageUrl?: unknown }} input
 * @returns {string | null}
 */
export function resolveMercadoLibreListingCoverImageUrl(input) {
  const { listing, pictureRows, productMainImageUrl } = input;
  const rows = Array.isArray(pictureRows) ? pictureRows : [];
  const { dbCover, apiImage, productCover, resolved } = computeMercadoLibreCoverResolution({
    listing,
    pictureRows: rows,
    productMainImageUrl,
  });

  const extRaw = listing?.external_listing_id;
  const norm = normalizeMercadoLibreExternalListingId(extRaw);
  const logThis =
    process.env.SUSE7_LOG_LISTING_COVER_RESOLVER === "1" ||
    (norm && LISTING_COVER_INLINE_TRACE_IDS.has(norm));

  if (logThis) {
    console.log(
      JSON.stringify({
        tag: "ml/listing-cover-resolve",
        external_listing_id: extRaw != null ? String(extRaw).trim() : null,
        pictureRows_count: rows.length,
        dbCover: dbCover || null,
        apiImage: apiImage || null,
        productCover: productCover || null,
        resolved: resolved || null,
      })
    );
  }

  return resolved;
}

/**
 * Payload interno. `coverThumbnailUrl` deve coincidir com `resolveMercadoLibreListingCoverImageUrl`.
 * @param {Record<string, unknown>} listing
 * @param {unknown} productMainImageUrl
 * @param {string | null | undefined} coverThumbnailUrl
 * @param {unknown[] | undefined} pictureRows
 */
export function buildListingCoverTracePayload(
  listing,
  productMainImageUrl,
  coverThumbnailUrl,
  pictureRows
) {
  const { dbCover, apiImage, productCover, item, resolved: internalResolved } =
    computeMercadoLibreCoverResolution({
      listing,
      pictureRows: Array.isArray(pictureRows) ? pictureRows : [],
      productMainImageUrl,
    });
  const finalUrl =
    coverThumbnailUrl != null && String(coverThumbnailUrl).trim() !== ""
      ? String(coverThumbnailUrl).trim()
      : null;

  const payload = buildListingCoverDebugPayload(
    listing,
    dbCover,
    productCover,
    item,
    apiImage,
    finalUrl ?? internalResolved ?? null
  );
  return {
    ...payload,
    cover_thumbnail_url: finalUrl,
  };
}

/**
 * Amostra das linhas `marketplace_listing_pictures` para debug (ordem position ASC).
 * @param {unknown[]} rows
 * @param {number} [maxRows]
 * @param {number} [maxUrlLen]
 */
function buildPictureRowsPreview(rows, maxRows = 14, maxUrlLen = 220) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  /** @param {unknown} row */
  const sortKey = (row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return DB_PICTURE_POSITION_FALLBACK;
    const p = /** @type {{ position?: unknown }} */ (row).position;
    return p != null && Number.isFinite(Number(p)) ? Number(p) : DB_PICTURE_POSITION_FALLBACK;
  };
  const sorted = [...rows].sort((a, b) => sortKey(a) - sortKey(b));
  const clip = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    return s.length <= maxUrlLen ? s : `${s.slice(0, maxUrlLen)}…`;
  };
  return sorted.slice(0, maxRows).map((r) => {
    const row = /** @type {{ position?: unknown; secure_url?: unknown; url?: unknown }} */ (r);
    return {
      position: row.position != null && Number.isFinite(Number(row.position)) ? Number(row.position) : null,
      secure_url: clip(row.secure_url),
      url: clip(row.url),
    };
  });
}

/**
 * Qual camada ganhou na cadeia db → api → product (mesma ordem do resolver).
 * @param {string | null} dbCover
 * @param {string | null} apiImage
 * @param {string | null} productCover
 * @param {string | null} resolved
 * @returns {"db"|"api"|"product"|null}
 */
function coverResolutionLayer(dbCover, apiImage, productCover, resolved) {
  if (!resolved) return null;
  if (dbCover && resolved === dbCover) return "db";
  if (apiImage && resolved === apiImage) return "api";
  if (productCover && resolved === productCover) return "product";
  return null;
}

/**
 * Bloco `_listing_cover_trace` no objeto da linha da grid (GET /api/ml/listings — IDs em LISTING_COVER_INLINE_TRACE_IDS).
 * @param {Record<string, unknown>} listing
 * @param {unknown} productMainImageUrl
 * @param {string | null | undefined} coverThumbnailUrl
 * @param {unknown[] | undefined} pictureRows
 */
export function buildListingCoverInlineTrace(
  listing,
  productMainImageUrl,
  coverThumbnailUrl,
  pictureRows
) {
  const rows = Array.isArray(pictureRows) ? pictureRows : [];
  const { dbCover, apiImage, productCover, item, resolved: internalResolved } = computeMercadoLibreCoverResolution({
    listing,
    pictureRows: rows,
    productMainImageUrl,
  });

  const extId = listing?.external_listing_id != null ? String(listing.external_listing_id).trim() : "";
  const finalUrl =
    coverThumbnailUrl != null && String(coverThumbnailUrl).trim() !== ""
      ? String(coverThumbnailUrl).trim()
      : null;

  const dbg = buildListingCoverDebugPayload(
    listing,
    dbCover,
    productCover,
    item,
    apiImage,
    finalUrl ?? internalResolved ?? null
  );

  return {
    external_listing_id: extId || null,
    pictures_count_column: listing?.pictures_count ?? null,
    pictureRows_count: rows.length,
    pictureRows_preview: buildPictureRowsPreview(rows),
    dbCover: dbCover || null,
    apiImage: apiImage || null,
    productCover: productCover || null,
    resolved: internalResolved || null,
    cover_thumbnail_url_final: finalUrl,
    cover_resolution_layer: coverResolutionLayer(dbCover, apiImage, productCover, internalResolved),
    parseRawJson_ok: dbg.parseRawJson_ok,
    pictures_array_len: dbg.pictures_array_len,
    cover_zeroed_by: dbg.cover_zeroed_by,
    loss_hint: dbg.loss_hint,
  };
}

/**
 * @param {unknown} prodRel — join PostgREST products (objeto ou array)
 * @returns {string | null}
 */
export function firstProductImageUrlFromJoin(prodRel) {
  if (!prodRel || typeof prodRel !== "object") return null;
  const row = Array.isArray(prodRel) ? prodRel[0] : prodRel;
  if (!row || typeof row !== "object") return null;
  const pi = /** @type {{ product_images?: unknown }} */ (row).product_images;
  if (!Array.isArray(pi) || pi.length === 0) return null;
  const first = pi[0];
  if (!first || typeof first !== "object") return null;
  const u = /** @type {{ url?: unknown }} */ (first).url;
  return normalizeHttpUrl(u);
}
