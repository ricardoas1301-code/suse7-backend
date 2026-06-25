// ======================================================
// PATCH /api/pricing/intelligent/:listingId/financial-settings
// Persiste % de promo, ML Ads, afiliados e reserva por anúncio.
// ======================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import {
  parseFinancialSettingsBody,
  persistListingFinancialSettings,
  readListingFinancialSettings,
} from "../../domain/pricing/listingFinancialSettings.js";

/**
 * @param {import("http").IncomingMessage & { params?: { listing_id?: string } }} req
 * @param {import("http").ServerResponse} res
 */
export default async function handlePricingIntelligentFinancialSettings(req, res) {
  if (req.method !== "PATCH" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const listingId =
    req.params?.listing_id != null ? String(req.params.listing_id).trim() : "";
  if (!listingId) {
    return res.status(400).json({ ok: false, error: "listing_id é obrigatório." });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "precificacoes" })) return;

  const { data: row, error: qErr } = await supabase
    .from("marketplace_listings")
    .select("id, raw_json, marketplace, external_listing_id, marketplace_account_id, seller_company_id, user_id")
    .eq("id", listingId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (qErr || !row) {
    return res.status(404).json({ ok: false, error: "Anúncio não encontrado." });
  }

  if (req.method === "GET") {
    const readResult = await readListingFinancialSettings(supabase, user.id, row);
    return res.status(200).json({
      ok: true,
      listing_id: listingId,
      financial_settings: readResult.financial_settings,
      source: readResult.source,
    });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido." });
  }

  let config;
  try {
    config = parseFinancialSettingsBody(body);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : "Payload inválido.",
    });
  }

  const persistResult = await persistListingFinancialSettings(supabase, user.id, row, config);
  if (!persistResult.ok) {
    return res.status(500).json({
      ok: false,
      error: persistResult.error ?? "Não foi possível salvar as configurações.",
    });
  }

  return res.status(200).json({
    ok: true,
    listing_id: listingId,
    financial_settings: persistResult.financial_settings,
    source: persistResult.source,
  });
}
