// ======================================================================
// Medidas normalizadas do anúncio ML para measurements_summary
// ======================================================================

import {
  parseMercadoLivreWeightToKg,
  resolveMercadoLivreAssembledDimensions,
  resolveMercadoLivreShippingDimensions,
} from "../../marketplace/adapters/mercadoLivreProductDataAdapter.js";

/**
 * @param {unknown} value
 */
function parseDecimalOrNull(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * ML: "altura x largura x comprimento, peso_gramas" (cm + gramas).
 * @param {unknown} raw
 */
export function parseMercadoLivreDimensionsString(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  const commaIndex = text.indexOf(",");
  const dimsPart = commaIndex >= 0 ? text.slice(0, commaIndex).trim() : text;
  const weightPart = commaIndex >= 0 ? text.slice(commaIndex + 1).trim() : null;
  const parts = dimsPart.split("x").map((part) => parseDecimalOrNull(part.trim()));
  if (parts.length !== 3 || parts.some((part) => part == null)) return null;

  const [heightCm, widthCm, lengthCm] = parts;
  let weightKg = null;
  if (weightPart != null && weightPart !== "") {
    weightKg = parseMercadoLivreWeightToKg(`${weightPart} g`);
    if (weightKg == null) {
      weightKg = parseMercadoLivreWeightToKg(weightPart);
    }
  }

  return {
    width_cm: widthCm,
    height_cm: heightCm,
    length_cm: lengthCm,
    weight_kg: weightKg,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} rawItem
 */
export function resolveMercadoLivreListingMeasurements(rawItem) {
  const shippingFromAttrs = resolveMercadoLivreShippingDimensions(rawItem);
  const assembledRaw = resolveMercadoLivreAssembledDimensions(rawItem);
  const fromDimensionsString = parseMercadoLivreDimensionsString(rawItem?.dimensions);

  const shipping = {
    width_cm: shippingFromAttrs.width ?? fromDimensionsString?.width_cm ?? null,
    height_cm: shippingFromAttrs.height ?? fromDimensionsString?.height_cm ?? null,
    length_cm: shippingFromAttrs.length ?? fromDimensionsString?.length_cm ?? null,
    weight_kg:
      shippingFromAttrs.weight ??
      fromDimensionsString?.weight_kg ??
      parseMercadoLivreWeightToKg(rawItem?.weight),
  };

  const productMounted = {
    width_cm: assembledRaw.assembled_width ?? null,
    height_cm: assembledRaw.assembled_height ?? null,
    length_cm: assembledRaw.assembled_length ?? null,
    weight_kg: assembledRaw.assembled_weight ?? null,
  };

  return { shipping, product_mounted: productMounted };
}
