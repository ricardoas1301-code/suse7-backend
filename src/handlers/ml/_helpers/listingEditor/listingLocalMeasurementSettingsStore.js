/**
 * Persistência local de pesos/medidas por anúncio (S1.24+).
 * Prioriza tabela dedicada; fallback em marketplace_listings.raw_json quando a migration ainda não foi aplicada.
 */

/**
 * @param {unknown} error
 */
export function isMissingLocalMeasurementSettingsTableError(error) {
  if (!error || typeof error !== "object") return false;
  const code = String(/** @type {{ code?: string }} */ (error).code ?? "");
  const message = String(/** @type {{ message?: string }} */ (error).message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    message.includes("marketplace_listing_measurement_settings") ||
    message.includes("does not exist") ||
    message.includes("could not find the table") ||
    message.includes("schema cache")
  );
}

/**
 * @param {unknown} rawJson
 */
function extrairSettingsDeRawJson(rawJson) {
  if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) return null;
  const nested = /** @type {Record<string, unknown>} */ (rawJson).s7_listing_measurement_settings;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  return /** @type {Record<string, unknown>} */ (nested);
}

/**
 * @param {Record<string, unknown> | null | undefined} settings
 */
export function normalizarListingLocalMeasurementSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return {
      shipping: {
        width_cm: null,
        height_cm: null,
        length_cm: null,
        weight_kg: null,
      },
      product_mounted: {
        width_cm: null,
        height_cm: null,
        length_cm: null,
        weight_kg: null,
      },
    };
  }

  return {
    shipping: {
      width_cm: settings.shipping_width_cm ?? null,
      height_cm: settings.shipping_height_cm ?? null,
      length_cm: settings.shipping_length_cm ?? null,
      weight_kg: settings.shipping_weight_kg ?? null,
    },
    product_mounted: {
      width_cm: settings.product_width_cm ?? null,
      height_cm: settings.product_height_cm ?? null,
      length_cm: settings.product_length_cm ?? null,
      weight_kg: settings.product_weight_kg ?? null,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {Record<string, unknown> | null | undefined} [listingRow]
 */
export async function carregarListingLocalMeasurementSettings(supabase, userId, listingId, listingRow = null) {
  try {
    const { data, error } = await supabase
      .from("marketplace_listing_measurement_settings")
      .select(
        "shipping_width_cm, shipping_height_cm, shipping_length_cm, shipping_weight_kg, product_width_cm, product_height_cm, product_length_cm, product_weight_kg, source, updated_at, updated_by",
      )
      .eq("listing_id", listingId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && data && typeof data === "object") {
      return {
        source: "table",
        settings: normalizarListingLocalMeasurementSettings(/** @type {Record<string, unknown>} */ (data)),
        raw: data,
      };
    }

    if (error && !isMissingLocalMeasurementSettingsTableError(error)) {
      console.warn("[LISTING_MEASUREMENT_LOAD]", {
        listing_id: listingId,
        code: error.code ?? null,
        message: error.message ?? null,
      });
    }
  } catch (loadErr) {
    console.warn("[LISTING_MEASUREMENT_LOAD]", {
      listing_id: listingId,
      message: loadErr instanceof Error ? loadErr.message : String(loadErr),
    });
  }

  const rawSettings = extrairSettingsDeRawJson(listingRow?.raw_json);
  if (rawSettings) {
    return {
      source: "raw_json",
      settings: normalizarListingLocalMeasurementSettings(rawSettings),
      raw: rawSettings,
    };
  }

  if (!listingRow) {
    const { data: row } = await supabase
      .from("marketplace_listings")
      .select("raw_json")
      .eq("id", listingId)
      .eq("user_id", userId)
      .maybeSingle();
    const fromRow = extrairSettingsDeRawJson(row?.raw_json);
    if (fromRow) {
      return {
        source: "raw_json",
        settings: normalizarListingLocalMeasurementSettings(fromRow),
        raw: fromRow,
      };
    }
  }

  return { source: "none", settings: normalizarListingLocalMeasurementSettings(null), raw: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {{
 *   shipping_width_cm?: number | null;
 *   shipping_height_cm?: number | null;
 *   shipping_length_cm?: number | null;
 *   shipping_weight_kg?: number | null;
 *   product_width_cm?: number | null;
 *   product_height_cm?: number | null;
 *   product_length_cm?: number | null;
 *   product_weight_kg?: number | null;
 * }} input
 */
export async function salvarListingLocalMeasurementSettings(supabase, userId, listingId, input) {
  const nowIso = new Date().toISOString();
  const payload = {
    listing_id: listingId,
    user_id: userId,
    shipping_width_cm: input.shipping_width_cm ?? null,
    shipping_height_cm: input.shipping_height_cm ?? null,
    shipping_length_cm: input.shipping_length_cm ?? null,
    shipping_weight_kg: input.shipping_weight_kg ?? null,
    product_width_cm: input.product_width_cm ?? null,
    product_height_cm: input.product_height_cm ?? null,
    product_length_cm: input.product_length_cm ?? null,
    product_weight_kg: input.product_weight_kg ?? null,
    source: "local_override",
    updated_at: nowIso,
    updated_by: userId,
  };

  const { error: upsertErr } = await supabase
    .from("marketplace_listing_measurement_settings")
    .upsert(payload, { onConflict: "listing_id" });

  if (!upsertErr) {
    return { ok: true, source: "table", updated_at: nowIso };
  }

  if (!isMissingLocalMeasurementSettingsTableError(upsertErr)) {
    console.error("[LISTING_MEASUREMENT_SAVE]", {
      listing_id: listingId,
      code: upsertErr.code ?? null,
      message: upsertErr.message ?? null,
    });
    return { ok: false, error: upsertErr };
  }

  const { data: listingRow, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select("id, raw_json")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (listingErr || !listingRow) {
    return { ok: false, error: listingErr ?? upsertErr, code: "listing_not_found" };
  }

  const rawCurrent =
    listingRow.raw_json && typeof listingRow.raw_json === "object" && !Array.isArray(listingRow.raw_json)
      ? /** @type {Record<string, unknown>} */ (listingRow.raw_json)
      : {};

  const rawNext = {
    ...rawCurrent,
    s7_listing_measurement_settings: {
      shipping_width_cm: payload.shipping_width_cm,
      shipping_height_cm: payload.shipping_height_cm,
      shipping_length_cm: payload.shipping_length_cm,
      shipping_weight_kg: payload.shipping_weight_kg,
      product_width_cm: payload.product_width_cm,
      product_height_cm: payload.product_height_cm,
      product_length_cm: payload.product_length_cm,
      product_weight_kg: payload.product_weight_kg,
      source: payload.source,
      updated_at: nowIso,
      updated_by: userId,
    },
  };

  const { error: updateErr } = await supabase
    .from("marketplace_listings")
    .update({ raw_json: rawNext, updated_at: nowIso })
    .eq("id", listingId)
    .eq("user_id", userId);

  if (updateErr) {
    return { ok: false, error: updateErr, code: "raw_json_failed" };
  }

  return { ok: true, source: "raw_json_fallback", updated_at: nowIso };
}
