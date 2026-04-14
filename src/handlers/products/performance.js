import { createClient } from "@supabase/supabase-js";
import Decimal from "decimal.js";
import { config } from "../../infra/config.js";
import { fail, getTraceId, ok } from "../../infra/http.js";

/** @param {string} v */
function isUuidLike(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function emptyPerformancePayload() {
  return {
    ok: true,
    sales_over_time: [],
    revenue_over_time: [],
    total_orders: 0,
    total_revenue: "0.00",
    avg_ticket: "0.00",
    conversion_rate: null,
  };
}

/**
 * @param {import("../../infra/http.js").VercelRequestCompat} req
 * @param {import("../../infra/http.js").VercelResponseCompat} res
 */
export async function handleProductsPerformance(req, res) {
  const traceId = getTraceId(req);
  if (req.method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  try {
    console.info("[products/performance] handler_enter", {
      method: req.method,
      url: req.url || null,
      has_params: req.params != null,
    });
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

    const productIdFromParams = String(req.params?.id || "").trim();
    const pathFromUrl = (() => {
      try {
        const baseUrl = `http://${req.headers?.host || "localhost"}`;
        const url = new URL(req.url || "/api", baseUrl);
        const m = url.pathname.match(/^\/api\/products\/([^/]+)\/performance$/);
        return m?.[1] ? String(m[1]).trim() : "";
      } catch {
        return "";
      }
    })();
    const productId = productIdFromParams || pathFromUrl;
    console.info("[products/performance] product_id_received", {
      productIdFromParams,
      pathFromUrl,
      productId,
    });
    if (!productId || !isUuidLike(productId)) {
      console.warn("[products/performance] invalid_product_id_fallback_200", {
        productIdFromParams,
        pathFromUrl,
        productId,
      });
      return ok(res, emptyPerformancePayload());
    }

    const { data: owns, error: ownErr } = await supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (ownErr) {
      console.error("[products/performance] ownership_error", {
        productId,
        code: ownErr.code,
        message: ownErr.message,
        details: ownErr.details,
      });
      return ok(res, emptyPerformancePayload());
    }
    if (!owns) {
      console.warn("[products/performance] product_not_found_fallback_200", { productId });
      return ok(res, emptyPerformancePayload());
    }

    const { data: snaps, error: qErr } = await supabase
      .from("marketplace_listing_snapshots")
      .select("captured_at, marketplace_payout_amount, net_receivable, orders")
      .eq("product_id", productId)
      .order("captured_at", { ascending: true });
    console.info("[products/performance] snapshots_query_executed", { productId });
    if (qErr) {
      console.error("[products/performance] snapshots_query_error", {
        productId,
        code: qErr.code,
        message: qErr.message,
        details: qErr.details,
        stack: qErr.stack ? String(qErr.stack).split("\n").slice(0, 2).join(" | ") : null,
      });
      const qCode = qErr.code != null ? String(qErr.code) : "";
      if (
        qCode === "42P01" ||
        qCode === "42703" ||
        qCode === "PGRST205" ||
        /does not exist|Could not find the table|Could not find the .* column/i.test(String(qErr.message || ""))
      ) {
        console.warn("[products/performance] snapshots_table_missing", {
          productId,
          code: qErr.code,
          message: qErr.message,
        });
        return ok(res, {
          ...emptyPerformancePayload(),
        });
      }
      return ok(res, emptyPerformancePayload());
    }
    console.info("[products/performance] query_ok", {
      productId,
      snapshots_count: Array.isArray(snaps) ? snaps.length : 0,
    });

    /** @type {Map<string, { orders: Decimal; revenue: Decimal }>} */
    const byDay = new Map();
    for (const s of snaps || []) {
      const dt = s.captured_at != null ? String(s.captured_at).slice(0, 10) : null;
      if (!dt) continue;
      const orders = Number.isFinite(Number(s.orders)) ? Math.max(0, Math.trunc(Number(s.orders))) : 0;
      const unitRaw =
        s.marketplace_payout_amount != null && String(s.marketplace_payout_amount).trim() !== ""
          ? s.marketplace_payout_amount
          : s.net_receivable;
      const net = Number.isFinite(Number(unitRaw)) ? new Decimal(String(unitRaw)) : new Decimal(0);
      const prev = byDay.get(dt) ?? { orders: new Decimal(0), revenue: new Decimal(0) };
      const ordDec = new Decimal(orders);
      byDay.set(dt, {
        orders: prev.orders.plus(ordDec),
        revenue: prev.revenue.plus(net.times(ordDec)),
      });
    }

    const keys = [...byDay.keys()].sort();
    const sales_over_time = keys.map((d) => ({ date: d, value: byDay.get(d).orders.toNumber() }));
    const revenue_over_time = keys.map((d) => ({
      date: d,
      value: byDay.get(d).revenue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    }));
    const totalOrdersDec = keys.reduce((acc, d) => acc.plus(byDay.get(d).orders), new Decimal(0));
    const totalRevenueDec = keys.reduce((acc, d) => acc.plus(byDay.get(d).revenue), new Decimal(0));
    const avgTicketDec = totalOrdersDec.gt(0) ? totalRevenueDec.div(totalOrdersDec) : new Decimal(0);

    return ok(res, {
      ok: true,
      sales_over_time,
      revenue_over_time,
      total_orders: totalOrdersDec.toNumber(),
      total_revenue: totalRevenueDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      avg_ticket: avgTicketDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      conversion_rate: null,
    });
  } catch (err) {
    console.error("[products/performance] internal_error_fallback_200", {
      code: err?.code ?? null,
      message: err?.message || String(err),
      stack: err?.stack ? String(err.stack).split("\n").slice(0, 3).join(" | ") : null,
      traceId,
    });
    return ok(res, emptyPerformancePayload());
  }
}
