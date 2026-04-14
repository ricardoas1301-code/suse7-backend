// ======================================================
// GET /api/products/listings?product_id=<uuid>
// Anúncios de marketplace vinculados a um produto (multi-marketplace).
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";

/**
 * @param {import("../../infra/http.js").VercelRequestCompat} req
 * @param {import("../../infra/http.js").VercelResponseCompat} res
 */
export async function handleProductsListings(req, res) {
  const traceId = getTraceId(req);

  if (req.method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token não informado" }, 401, traceId);
    }
    const token = authHeader.slice(7);

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token inválido" }, 401, traceId);
    }

    const baseUrl = `http://${req.headers?.host || "localhost"}`;
    const url = new URL(req.url || "/api", baseUrl);
    const productId = String(url.searchParams.get("product_id") || req.query?.product_id || "").trim();

    if (!productId) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "Query product_id (UUID) é obrigatória" },
        400,
        traceId,
      );
    }

    const { data: owns, error: ownErr } = await supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (ownErr) {
      console.error("[products/listings] ownership", ownErr);
      return fail(res, { code: "DB_ERROR", message: ownErr.message || "Erro ao validar produto" }, 500, traceId);
    }
    if (!owns) {
      return fail(res, { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" }, 404, traceId);
    }

    const { data: rows, error: qErr } = await supabase
      .from("marketplace_listings")
      .select(
        "id, marketplace, external_listing_id, title, seller_sku, seller_custom_field, status, price, original_price, base_price, permalink, api_last_seen_at",
      )
      .eq("user_id", user.id)
      .eq("product_id", productId)
      .order("api_last_seen_at", { ascending: false });

    if (qErr) {
      console.error("[products/listings] select", qErr);
      return fail(res, { code: "DB_ERROR", message: qErr.message || "Erro ao listar anúncios" }, 500, traceId);
    }

    const extIds = (rows || [])
      .map((r) => (r.external_listing_id != null ? String(r.external_listing_id).trim() : ""))
      .filter((x) => x !== "");
    const { data: healthRows } = extIds.length
      ? await supabase
          .from("marketplace_listing_health")
          .select("marketplace, external_listing_id, promotion_price, raw_json")
          .eq("user_id", user.id)
          .in("external_listing_id", extIds)
      : { data: [] };
    const healthByKey = new Map(
      (healthRows || []).map((h) => [`${String(h.marketplace)}::${String(h.external_listing_id)}`, h]),
    );

    const listings = (rows || []).map((r) => {
      const price = r.price != null ? Number(r.price) : null;
      const orig = r.original_price != null ? Number(r.original_price) : null;
      const base = r.base_price != null ? Number(r.base_price) : null;
      const onPromo =
        (() => {
          const key = `${String(r.marketplace)}::${String(r.external_listing_id)}`;
          const h = healthByKey.get(key);
          const pricing = h?.raw_json && typeof h.raw_json === "object" ? h.raw_json.suse7_pricing_resolution : null;
          if (pricing && typeof pricing === "object") {
            return pricing.promotion_active === true || pricing.has_valid_promotion === true;
          }
          const promoPrice = h?.promotion_price != null ? Number(h.promotion_price) : null;
          if (promoPrice != null && Number.isFinite(promoPrice) && price != null && promoPrice < price) return true;
          return (
            (orig != null && Number.isFinite(orig) && price != null && Number.isFinite(price) && orig > price + 0.004) ||
            (base != null && Number.isFinite(base) && price != null && Number.isFinite(price) && base > price + 0.004)
          );
        })();

      const sku =
        r.seller_custom_field != null && String(r.seller_custom_field).trim() !== ""
          ? String(r.seller_custom_field).trim()
          : r.seller_sku != null && String(r.seller_sku).trim() !== ""
            ? String(r.seller_sku).trim()
            : null;

      return {
        id: r.id != null ? String(r.id) : null,
        marketplace: r.marketplace != null ? String(r.marketplace) : null,
        external_listing_id:
          r.external_listing_id != null ? String(r.external_listing_id) : null,
        title: r.title != null ? String(r.title) : null,
        sku,
        status: r.status != null ? String(r.status) : null,
        price_brl: price != null && Number.isFinite(price) ? price.toFixed(2) : null,
        is_on_promotion: Boolean(onPromo),
        last_sync_at: r.api_last_seen_at != null ? String(r.api_last_seen_at) : null,
        permalink: r.permalink != null ? String(r.permalink) : null,
      };
    });

    return ok(res, { ok: true, listings });
  } catch (err) {
    console.error("[products/listings] fail", err);
    return fail(
      res,
      {
        code: "INTERNAL_ERROR",
        message: "Erro interno",
        details: err?.message || String(err),
      },
      500,
      traceId,
    );
  }
}
