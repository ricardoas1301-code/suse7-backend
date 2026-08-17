import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { inteiroNaoNegativoOuNull } from "../../domain/listings/stock/normalizeListingVirtualStockSummary.js";
import { salvarListingVirtualStockSettings } from "./_helpers/listingEditor/listingVirtualStockSettingsStore.js";

/**
 * @param {unknown} value
 */
function textoOuVazio(value) {
  return value != null ? String(value).trim() : "";
}

export default async function handleListingEditorStockSettingsUpdate(req, res) {
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

  const overrideEnabled = body.listing_virtual_stock_override_enabled === true;
  const overrideValue = overrideEnabled ? inteiroNaoNegativoOuNull(body.listing_virtual_stock_value) : null;
  if (overrideEnabled && overrideValue == null) {
    return res.status(400).json({ ok: false, error: "Informe o estoque virtual deste anúncio." });
  }

  const { user, supabase } = auth;
  const { data: listingRow, error: listingErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id")
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (listingErr || !listingRow) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  const saveResult = await salvarListingVirtualStockSettings(supabase, user.id, listingId, {
    overrideEnabled,
    overrideValue,
  });

  if (!saveResult.ok) {
    const err = saveResult.error;
    const devPayload =
      process.env.NODE_ENV !== "production"
        ? {
            code: err && typeof err === "object" ? /** @type {{ code?: string }} */ (err).code ?? null : null,
            message: err && typeof err === "object" ? /** @type {{ message?: string }} */ (err).message ?? null : null,
          }
        : undefined;

    return res.status(500).json({
      ok: false,
      error: "Não foi possível salvar as alterações de estoque virtual deste anúncio.",
      ...(devPayload ? { debug: devPayload } : {}),
    });
  }

  return res.status(200).json({
    ok: true,
    listing_id: listingId,
    stock_settings: {
      listing_virtual_stock_override_enabled: overrideEnabled,
      listing_virtual_stock_value: overrideEnabled ? overrideValue : null,
      updated_at: saveResult.updated_at,
      persistence_source: saveResult.source,
    },
  });
}
