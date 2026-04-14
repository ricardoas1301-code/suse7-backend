// ======================================================================
// GET /api/products/for-edit?id=<uuid>
// Carrega produto + product_variants para edição (service role + filtro user_id).
// Evita depender só do PostgREST no browser (RLS / sessão) e dá payload único para debug.
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { computeProductReadiness } from "../../domain/productReadiness.js";

export async function handleProductsForEdit(req, res) {
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
    const productId = String(url.searchParams.get("id") || req.query?.id || "").trim();

    if (!productId) {
      return fail(res, { code: "INVALID_INPUT", message: "Query id (UUID do produto) é obrigatória" }, 400, traceId);
    }

    const { data: product, error: pErr } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (pErr) {
      console.error("[products/for-edit] products select", pErr);
      return fail(
        res,
        { code: "DB_ERROR", message: pErr.message || "Erro ao carregar produto", details: String(pErr) },
        500,
        traceId
      );
    }

    if (!product) {
      return fail(res, { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" }, 404, traceId);
    }

    const { data: variantRows, error: vErr } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", productId)
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });

    if (vErr) {
      console.error("[products/for-edit] product_variants select", vErr);
      return fail(
        res,
        { code: "DB_ERROR", message: vErr.message || "Erro ao carregar variações", details: String(vErr) },
        500,
        traceId
      );
    }

    const variants = variantRows || [];

    const { data: imageLinkRows, error: imgErr } = await supabase
      .from("product_image_links")
      .select("storage_path, variant_key, sort_order, is_primary")
      .eq("product_id", productId)
      .eq("user_id", user.id);

    if (imgErr) {
      console.error("[products/for-edit] product_image_links select", imgErr);
    }

    const productWithLinks = {
      ...product,
      product_image_links: imageLinkRows || [],
    };

    const readiness = computeProductReadiness(productWithLinks);

    if (process.env.NODE_ENV !== "production") {
      const first = variants[0];
      console.info("[products/for-edit] ok", {
        productId,
        userId: user.id,
        variantCount: variants.length,
        sample: first
          ? {
              id: first.id,
              product_id: first.product_id,
              user_id: first.user_id,
              sku: first.sku,
              stock_quantity: first.stock_quantity,
              cost_price: first.cost_price,
              attributes: first.attributes,
              attributesType: typeof first.attributes,
            }
          : null,
      });
    }

    return ok(res, {
      ok: true,
      product: {
        ...productWithLinks,
        is_product_ready: readiness.is_product_ready,
        missing_fields: readiness.missing_fields,
        product_completeness_score: readiness.product_completeness_score,
      },
      variants,
    });
  } catch (err) {
    console.error("[products/for-edit] fail", err);
    return fail(
      res,
      {
        code: "INTERNAL_ERROR",
        message: "Erro interno",
        details: err?.message || String(err),
      },
      500,
      traceId
    );
  }
}
