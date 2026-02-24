// ======================================================================
// GET /api/products/health — Relatório de saúde do produto
// Avalia blocking, warnings e prontidão para publicar
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { evaluateProductHealth } from "../../domain/ProductHealthDomainService.js";

export async function handleProductsHealth(req, res) {
  if (req.method !== "GET") {
    const traceId = getTraceId(req);
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  const traceId = getTraceId(req);

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token não informado" }, 401, traceId);
    }
    const token = authHeader.slice(7);

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token inválido" }, 401, traceId);
    }

    const productId = req.query?.product_id || null;

    if (!productId) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "product_id é obrigatório" },
        400,
        traceId
      );
    }

    const { data: product, error: productError } = await supabase
      .from("products")
      .select(
        "id, user_id, product_name, sku, format, status, description, " +
        "stock_quantity, stock_minimum, min_stock_quantity"
      )
      .eq("id", productId)
      .eq("user_id", user.id)
      .single();

    if (productError || !product) {
      return fail(
        res,
        { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" },
        404,
        traceId
      );
    }

    const format = (product.format || "simple").toLowerCase();
    let variants = [];
    let adTitles = [];
    let imagesLinks = [];

    if (format === "variants") {
      const { data: vars } = await supabase
        .from("product_variants")
        .select("id, sku, stock_quantity, stock_minimum, min_stock_quantity, attributes")
        .eq("product_id", productId)
        .order("sort_order", { ascending: true });
      variants = vars || [];
    }

    const { data: titles } = await supabase
      .from("product_ad_titles")
      .select("id, title")
      .eq("product_id", productId)
      .eq("user_id", user.id)
      .eq("is_active", true);
    adTitles = titles || [];

    const { data: images } = await supabase
      .from("product_image_links")
      .select("id")
      .eq("product_id", productId);
    imagesLinks = images || [];

    const health = evaluateProductHealth(product, variants, adTitles, imagesLinks);

    return ok(res, {
      productId: product.id,
      status: product.status || "draft",
      readyToPublish: health.readyToPublish,
      blocking: health.blocking,
      warnings: health.warnings,
      meta: health.meta,
    });
  } catch (err) {
    console.error("[products/health] fail", err);
    return fail(
      res,
      {
        code: "INTERNAL_ERROR",
        message: "Erro interno",
        details: process.env.NODE_ENV === "development" ? String(err?.message) : undefined,
      },
      500,
      traceId
    );
  }
}
