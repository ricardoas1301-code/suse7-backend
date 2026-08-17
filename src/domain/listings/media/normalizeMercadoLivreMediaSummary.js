// ======================================================================
// Normalização de mídia — Mercado Livre (Raio-X do Anúncio).
// Helper puro, sem dependência de request.
// ======================================================================

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function textoOuNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text !== "" ? text : null;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arraySeguro(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} item
 */
function isVideoOuClip(item) {
  if (!item || typeof item !== "object") return false;
  const row = /** @type {Record<string, unknown>} */ (item);
  const type = String(row.type ?? row.media_type ?? row.content_type ?? row.kind ?? "").toLowerCase();
  const id = textoOuNull(row.id ?? row.video_id ?? row.clip_id);
  return Boolean(id || type.includes("video") || type.includes("clip"));
}

/**
 * @param {unknown} value
 */
function extrairArrayPayload(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const root = /** @type {Record<string, unknown>} */ (value);
  for (const key of ["results", "data", "videos", "clips", "items", "media"]) {
    if (Array.isArray(root[key])) return /** @type {unknown[]} */ (root[key]);
  }
  if (root.data && typeof root.data === "object") return extrairArrayPayload(root.data);
  return [];
}

/**
 * Conta vídeos/clips a partir do detalhe oficial `GET /items/{id}?include_attributes=all`.
 * @param {Record<string, unknown> | null | undefined} rawListing
 */
export function normalizeMercadoLivreMediaSummary(rawListing) {
  const root =
    rawListing && typeof rawListing === "object" && !Array.isArray(rawListing)
      ? /** @type {Record<string, unknown>} */ (rawListing)
      : {};

  const detailResult =
    root.item_full_detail && typeof root.item_full_detail === "object" && !Array.isArray(root.item_full_detail)
      ? /** @type {Record<string, unknown>} */ (root.item_full_detail)
      : null;

  if (detailResult && detailResult.ok === false) {
    return {
      clips_count: 0,
      clips_label: "0",
      has_clips: false,
      video_id_present: false,
      source: "api_error",
      source_confidence: "unknown",
    };
  }

  const item =
    detailResult?.ok === true && detailResult.data && typeof detailResult.data === "object" && !Array.isArray(detailResult.data)
      ? /** @type {Record<string, unknown>} */ (detailResult.data)
      : root;

  const videoId = textoOuNull(item.video_id);
  if (videoId) {
    return {
      clips_count: 1,
      clips_label: "1",
      has_clips: true,
      video_id_present: true,
      source: "item_video_id",
      source_confidence: detailResult?.ok === true ? "api_verified" : "fallback",
    };
  }

  const mediaArrays = [
    arraySeguro(item.clips),
    arraySeguro(item.videos),
    arraySeguro(item.video),
    arraySeguro(item.media).filter(isVideoOuClip),
    extrairArrayPayload(item),
  ];

  for (const arr of mediaArrays) {
    if (arr.length === 0) continue;
    const clipsCount = arr.filter(isVideoOuClip).length || arr.length;
    if (clipsCount <= 0) continue;
    return {
      clips_count: clipsCount,
      clips_label: String(clipsCount),
      has_clips: true,
      video_id_present: false,
      source: "item_media_array",
      source_confidence: detailResult?.ok === true ? "api_verified" : "fallback",
    };
  }

  return {
    clips_count: 0,
    clips_label: "0",
    has_clips: false,
    video_id_present: false,
    source: detailResult?.ok === true ? "item_without_video" : "unknown",
    source_confidence: detailResult?.ok === true ? "api_verified" : "unknown",
  };
}
