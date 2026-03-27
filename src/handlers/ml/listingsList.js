// ======================================================
// GET /api/ml/listings
// Lista anúncios importados do usuário autenticado (marketplace_listings).
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";

export default async function handleMlListingsList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  try {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select(
        "id, title, marketplace, price, available_quantity, sold_quantity, status, external_listing_id, permalink, health, api_last_seen_at, currency_id, pictures_count, variations_count"
      )
      .eq("user_id", user.id)
      .order("api_last_seen_at", { ascending: false });

    if (error) {
      console.error("[ml/listings] query_error", error);
      return res.status(500).json({ ok: false, error: "Erro ao listar anúncios" });
    }

    return res.status(200).json({ ok: true, listings: data ?? [] });
  } catch (err) {
    console.error("[ml/listings] fatal", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
}
