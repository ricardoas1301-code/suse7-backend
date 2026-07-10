// ======================================================================
// Chaves estáveis e ordenação local das imagens do anúncio
// ======================================================================

/**
 * @param {unknown} value
 */
export function textoOuNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * @param {Record<string, unknown>} pic
 */
export function listingPictureStableKey(pic) {
  const pictureId = textoOuNull(pic.picture_id) ?? textoOuNull(pic.id);
  if (pictureId) return `id:${pictureId}`;
  const url = textoOuNull(pic.url) ?? textoOuNull(pic.secure_url);
  if (url) return `url:${url}`;
  return null;
}

/**
 * @param {unknown} pictures
 */
export function normalizarListingPictures(pictures) {
  if (!Array.isArray(pictures)) return [];
  return pictures
    .map((pic, index) => {
      if (!pic || typeof pic !== "object") return null;
      const row = /** @type {Record<string, unknown>} */ (pic);
      const url = textoOuNull(row.url) ?? textoOuNull(row.secure_url);
      if (!url) return null;
      const positionRaw = Number(row.position);
      const pictureId = textoOuNull(row.picture_id) ?? textoOuNull(row.id);
      const normalized = {
        picture_id: pictureId,
        url,
        position: Number.isFinite(positionRaw) ? Math.trunc(positionRaw) : index,
      };
      return {
        ...normalized,
        stable_key: listingPictureStableKey(normalized),
      };
    })
    .filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizarOrderedPictureKeys(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => textoOuNull(item))
    .filter((item) => item != null);
}

/**
 * @param {Array<{ picture_id?: string | null; url?: string | null; stable_key?: string | null; position?: number }>} pictures
 * @param {{ ordered_picture_keys?: unknown; primary_picture_id?: string | null; primary_picture_url?: string | null } | null | undefined} savedSettings
 */
export function aplicarOrdemLocalNasImagensListing(pictures, savedSettings) {
  const normalized = normalizarListingPictures(pictures);
  if (normalized.length === 0) {
    return {
      pictures: [],
      ordered_picture_keys: [],
      effective_primary_picture_id: null,
      effective_primary_picture_url: null,
      effective_primary_picture_key: null,
      effective_primary_source: "none",
    };
  }

  const byKey = new Map(
    normalized
      .map((pic) => {
        const key = pic.stable_key ?? listingPictureStableKey(pic);
        return key ? [key, pic] : null;
      })
      .filter(Boolean),
  );

  let orderedKeys = normalizarOrderedPictureKeys(savedSettings?.ordered_picture_keys);
  let source = "marketplace_default";

  if (orderedKeys.length > 0) {
    source = "local_order";
  } else {
    const savedId = textoOuNull(savedSettings?.primary_picture_id);
    const savedUrl = textoOuNull(savedSettings?.primary_picture_url);
    const defaultOrder = [...normalized].sort((a, b) => Number(a.position) - Number(b.position));

    if (savedId || savedUrl) {
      /** @type {typeof normalized[number] | null} */
      let primaryMatch = null;
      if (savedId) primaryMatch = defaultOrder.find((pic) => pic.picture_id === savedId) ?? null;
      if (!primaryMatch && savedUrl) primaryMatch = defaultOrder.find((pic) => pic.url === savedUrl) ?? null;
      if (primaryMatch?.stable_key) {
        orderedKeys = [
          primaryMatch.stable_key,
          ...defaultOrder
            .filter((pic) => pic.stable_key !== primaryMatch.stable_key)
            .map((pic) => pic.stable_key)
            .filter(Boolean),
        ];
        source = "listing_override";
      }
    }

    if (orderedKeys.length === 0) {
      orderedKeys = defaultOrder.map((pic) => pic.stable_key).filter((key) => key != null);
    }
  }

  /** @type {typeof normalized} */
  const orderedPictures = [];
  for (const key of orderedKeys) {
    const pic = byKey.get(key);
    if (pic) {
      orderedPictures.push(pic);
      byKey.delete(key);
    }
  }

  const remaining = [...normalized].sort((a, b) => Number(a.position) - Number(b.position));
  for (const pic of remaining) {
    const key = pic.stable_key ?? listingPictureStableKey(pic);
    if (key && byKey.has(key)) {
      orderedPictures.push(pic);
      byKey.delete(key);
    }
  }

  const finalPictures = orderedPictures.map((pic, index) => ({
    ...pic,
    position: index,
    stable_key: pic.stable_key ?? listingPictureStableKey(pic),
  }));
  const finalKeys = finalPictures.map((pic) => pic.stable_key).filter((key) => key != null);
  const first = finalPictures[0] ?? null;

  return {
    pictures: finalPictures,
    ordered_picture_keys: finalKeys,
    effective_primary_picture_id: first?.picture_id ?? null,
    effective_primary_picture_url: first?.url ?? null,
    effective_primary_picture_key: first?.stable_key ?? null,
    effective_primary_source: source,
  };
}

/** @deprecated Use aplicarOrdemLocalNasImagensListing */
export function resolverImagemPrincipalListing(pictures, savedSettings) {
  const applied = aplicarOrdemLocalNasImagensListing(pictures, savedSettings);
  return {
    stable_key: applied.effective_primary_picture_key,
    picture_id: applied.effective_primary_picture_id,
    url: applied.effective_primary_picture_url,
    source: applied.effective_primary_source,
  };
}
