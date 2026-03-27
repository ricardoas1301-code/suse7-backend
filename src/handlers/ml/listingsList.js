// ======================================================
// GET /api/ml/listings
// Lista anúncios importados (marketplace_listings) + métricas de vendas
// + marketplace_listing_health + URL de capa (primeira foto persistida).
// ======================================================

import { requireAuthUser } from "./_helpers/requireAuthUser.js";

/** @param {string} marketplace @param {string} externalId */
function metricsKey(marketplace, externalId) {
  return `${marketplace}\t${externalId}`;
}

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
    const listingIds = listings.map((l) => l.id).filter(Boolean);

    const { data: healthRows, error: healthErr } = await supabase
      .from("marketplace_listing_health")
      .select(
        "marketplace, external_listing_id, visits, net_receivable, sale_fee_percent, sale_fee_amount, shipping_cost, promotion_price, listing_quality_score, listing_quality_status, experience_status, shipping_logistic_type"
      )
      .eq("user_id", user.id);

    if (healthErr) {
      console.error("[ml/listings] health_query_error", healthErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar saúde dos anúncios" });
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const healthByKey = new Map();
    for (const h of healthRows || []) {
      healthByKey.set(metricsKey(String(h.marketplace), String(h.external_listing_id)), h);
    }

    /** @type {Map<string, string>} */
    const coverByListingId = new Map();
    if (listingIds.length > 0) {
      const { data: picRows, error: picErr } = await supabase
        .from("marketplace_listing_pictures")
        .select("listing_id, secure_url, url, position")
        .in("listing_id", listingIds);

      if (picErr) {
        console.error("[ml/listings] pictures_query_error", picErr);
      } else {
        /** @type {Map<string, { pos: number; url: string }>} */
        const best = new Map();
        for (const p of picRows || []) {
          const lid = p.listing_id;
          const pos = p.position != null ? Number(p.position) : 1e9;
          const u = p.secure_url || p.url;
          if (!u) continue;
          const prev = best.get(lid);
          if (!prev || pos < prev.pos) best.set(lid, { pos, url: String(u) });
        }
        for (const [lid, v] of best) {
          coverByListingId.set(lid, v.url);
        }
      }
    }

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
      metricsByKey.set(metricsKey(String(m.marketplace), String(m.external_listing_id)), m);
    }

    const merged = listings.map((l) => {
      const mk = metricsKey(String(l.marketplace), String(l.external_listing_id));
      const met = metricsByKey.get(mk);
      const hlth = healthByKey.get(mk);
      const cover_thumbnail_url = l.id ? coverByListingId.get(l.id) ?? null : null;

      return {
        ...l,
        cover_thumbnail_url,
        metrics_qty_sold: met?.qty_sold_total ?? null,
        metrics_gross_revenue: met?.gross_revenue_total ?? null,
        metrics_net_revenue: met?.net_revenue_total ?? null,
        metrics_orders_count: met?.orders_count ?? null,
        metrics_last_sale_at: met?.last_sale_at ?? null,
        health_visits: hlth?.visits ?? null,
        health_net_receivable: hlth?.net_receivable ?? null,
        health_sale_fee_percent: hlth?.sale_fee_percent ?? null,
        health_sale_fee_amount: hlth?.sale_fee_amount ?? null,
        health_shipping_cost: hlth?.shipping_cost ?? null,
        health_promotion_price: hlth?.promotion_price ?? null,
        health_listing_quality_score: hlth?.listing_quality_score ?? null,
        health_listing_quality_status: hlth?.listing_quality_status ?? null,
        health_experience_status: hlth?.experience_status ?? null,
        health_shipping_logistic_type: hlth?.shipping_logistic_type ?? null,
      };
    });

    return res.status(200).json({ ok: true, listings: merged });
  } catch (err) {
    console.error("[ml/listings] fatal", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
}
