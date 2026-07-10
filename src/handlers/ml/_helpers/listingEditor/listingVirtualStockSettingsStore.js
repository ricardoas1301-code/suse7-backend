/**
 * Persistência do estoque virtual por anúncio (S1.14+).
 * Prioriza tabela dedicada; fallback em marketplace_listings.raw_json quando a migration ainda não foi aplicada.
 */

/**
 * @param {unknown} error
 */
export function isMissingVirtualStockSettingsTableError(error) {
  if (!error || typeof error !== "object") return false;
  const code = String(/** @type {{ code?: string }} */ (error).code ?? "");
  const message = String(/** @type {{ message?: string }} */ (error).message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    message.includes("marketplace_listing_virtual_stock_settings") ||
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
  const nested = /** @type {Record<string, unknown>} */ (rawJson).s7_listing_virtual_stock_settings;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  return /** @type {Record<string, unknown>} */ (nested);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {Record<string, unknown> | null | undefined} [listingRow]
 */
export async function carregarListingVirtualStockSettings(supabase, userId, listingId, listingRow = null) {
  try {
    const { data, error } = await supabase
      .from("marketplace_listing_virtual_stock_settings")
      .select("override_enabled, virtual_stock_value, updated_at, updated_by")
      .eq("listing_id", listingId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && data && typeof data === "object") {
      return { source: "table", settings: /** @type {Record<string, unknown>} */ (data) };
    }

    if (error && !isMissingVirtualStockSettingsTableError(error)) {
      console.warn("[LISTING_VIRTUAL_STOCK_LOAD]", {
        listing_id: listingId,
        code: error.code ?? null,
        message: error.message ?? null,
      });
    }
  } catch (loadErr) {
    console.warn("[LISTING_VIRTUAL_STOCK_LOAD]", {
      listing_id: listingId,
      message: loadErr instanceof Error ? loadErr.message : String(loadErr),
    });
  }

  const rawSettings = extrairSettingsDeRawJson(listingRow?.raw_json);
  if (rawSettings) {
    return { source: "raw_json", settings: rawSettings };
  }

  if (!listingRow) {
    const { data: row } = await supabase
      .from("marketplace_listings")
      .select("raw_json")
      .eq("id", listingId)
      .eq("user_id", userId)
      .maybeSingle();
    const fromRow = extrairSettingsDeRawJson(row?.raw_json);
    if (fromRow) return { source: "raw_json", settings: fromRow };
  }

  return { source: "none", settings: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} listingId
 * @param {{ overrideEnabled: boolean; overrideValue: number | null }} input
 */
export async function salvarListingVirtualStockSettings(supabase, userId, listingId, input) {
  const nowIso = new Date().toISOString();
  const payload = {
    listing_id: listingId,
    user_id: userId,
    override_enabled: input.overrideEnabled === true,
    virtual_stock_value: input.overrideEnabled ? input.overrideValue : null,
    updated_at: nowIso,
    updated_by: userId,
  };

  const { error: upsertErr } = await supabase
    .from("marketplace_listing_virtual_stock_settings")
    .upsert(payload, { onConflict: "listing_id" });

  if (!upsertErr) {
    return { ok: true, source: "table", updated_at: nowIso };
  }

  if (!isMissingVirtualStockSettingsTableError(upsertErr)) {
    console.error("[LISTING_VIRTUAL_STOCK_SAVE]", {
      listing_id: listingId,
      code: upsertErr.code ?? null,
      message: upsertErr.message ?? null,
      details: upsertErr.details ?? null,
      hint: upsertErr.hint ?? null,
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
    s7_listing_virtual_stock_settings: {
      override_enabled: payload.override_enabled,
      virtual_stock_value: payload.virtual_stock_value,
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
    console.error("[LISTING_VIRTUAL_STOCK_SAVE_RAW_JSON]", {
      listing_id: listingId,
      code: updateErr.code ?? null,
      message: updateErr.message ?? null,
    });
    return { ok: false, error: updateErr, code: "raw_json_failed" };
  }

  console.info("[LISTING_VIRTUAL_STOCK_SAVE]", {
    listing_id: listingId,
    source: "raw_json_fallback",
    note: "Tabela marketplace_listing_virtual_stock_settings ausente; aplicar migration S1.14.",
  });

  return { ok: true, source: "raw_json_fallback", updated_at: nowIso };
}
