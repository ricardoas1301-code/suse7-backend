// ======================================================
// GET /api/ml/listings
// Lista anúncios importados do usuário autenticado (marketplace_listings).
// Enriquece com Fase 3 (listing_sales_metrics) quando existir sync de vendas.
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

    const listings = data ?? [];

    const marketplaces = [...new Set(listings.map((l) => l.marketplace).filter(Boolean))];
    const { data: metricsRows, error: metErr } =
      marketplaces.length === 0
        ? { data: [], error: null }
        : await supabase
            .from("listing_sales_metrics")
            .select(
              "marketplace, external_listing_id, qty_sold_total, gross_revenue_total, net_revenue_total, orders_count, last_sale_at"
            )
            .eq("user_id", user.id)
            .in("marketplace", marketplaces);

    if (metErr) {
      console.error("[ml/listings] metrics_query_error", metErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar métricas de vendas" });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const metricsByKey = new Map();
    for (const m of metricsRows || []) {
      const mk = `${m.marketplace}\t${m.external_listing_id}`;
      metricsByKey.set(mk, m);
    }

    const merged = listings.map((l) => {
      const mk = `${l.marketplace}\t${l.external_listing_id}`;
      const met = metricsByKey.get(mk);
      return {
        ...l,
        metrics_qty_sold: met?.qty_sold_total ?? null,
        metrics_gross_revenue: met?.gross_revenue_total ?? null,
        metrics_net_revenue: met?.net_revenue_total ?? null,
        metrics_orders_count: met?.orders_count ?? null,
        metrics_last_sale_at: met?.last_sale_at ?? null,
      };
    });

    return res.status(200).json({ ok: true, listings: merged });
  } catch (err) {
    console.error("[ml/listings] fatal", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
}
