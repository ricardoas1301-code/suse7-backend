// ======================================================================
// GET /api/products/health — Relatório de saúde do produto
// Avalia blocking, warnings e prontidão para publicar
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { evaluateProductHealth } from "../../domain/ProductHealthDomainService.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(str) {
  return typeof str === "string" && str.trim() !== "" && UUID_REGEX.test(str.trim());
}

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

    const productId = req.query?.product_id ?? null;
    const productIdTrimmed = typeof productId === "string" ? productId.trim() : "";

    if (!productIdTrimmed) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "product_id é obrigatório (query: ?product_id=uuid)" },
        400,
        traceId
      );
    }

    if (!isValidUUID(productIdTrimmed)) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "product_id deve ser um UUID válido" },
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
      .eq("id", productIdTrimmed)
      .eq("user_id", user.id)
      .single();

    if (productError || !product) {
      return ok(res, {
        productId: productIdTrimmed,
        status: "not_found",
        readyToPublish: false,
        blocking: [],
        warnings: [],
        meta: {},
      });
    }

    const format = (product.format || "simple").toLowerCase();
    let variants = [];
    let adTitles = [];
    let imagesLinks = [];

    if (format === "variants") {
      const { data: vars } = await supabase
        .from("product_variants")
        .select("id, sku, stock_quantity, stock_minimum, min_stock_quantity, attributes")
        .eq("product_id", product.id)
        .order("sort_order", { ascending: true });
      variants = vars || [];
    }

    const { data: titles } = await supabase
      .from("product_ad_titles")
      .select("id, title")
      .eq("product_id", product.id)
      .eq("user_id", user.id)
      .eq("is_active", true);
    adTitles = titles || [];

    const { data: images } = await supabase
      .from("product_image_links")
      .select("id")
      .eq("product_id", product.id);
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
