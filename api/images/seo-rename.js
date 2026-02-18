// ======================================================================
// POST /api/images/seo-rename — Renomeia imagens do escopo com SEO
// Input: { productId, variantKey? }
// product_name e seo_keywords: SEMPRE do DB (products)
// variantKey: null | "__ALL__" | string — "__ALL__" = global + todas variações
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";

const BUCKET = "product-images";
const LOG_PREFIX = "[SEO_RENAME]";
const ALL_SCOPES = "__ALL__";

function slugify(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getExt(path) {
  const m = (path || "").match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "jpg";
}

function buildNewFileName(productSlug, keywordsSlug, index, ext, uniq) {
  return `${productSlug || "img"}-${keywordsSlug || "seo"}-${index}-${uniq}.${ext}`;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && config.corsAllowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido", code: "METHOD_NOT_ALLOWED" });
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token não informado", code: "UNAUTHORIZED" });
    }
    const token = authHeader.slice(7);

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      console.warn(`${LOG_PREFIX} auth fail`, { error: authError?.message });
      return res.status(401).json({ error: "Token inválido", code: "UNAUTHORIZED" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { productId, variantKey } = body;

    const productIdStr = productId && String(productId).trim();
    if (!productIdStr) {
      return res.status(400).json({ error: "productId é obrigatório", code: "INVALID_INPUT" });
    }

    const { data: product, error: productError } = await supabase
      .from("products")
      .select("product_name, seo_keywords, user_id")
      .eq("id", productIdStr)
      .eq("user_id", user.id)
      .single();

    if (productError || !product) {
      return res.status(404).json({ error: "Produto não encontrado", code: "PRODUCT_NOT_FOUND" });
    }

    const productName = product.product_name || "";
    const seoKeywords = product.seo_keywords || "";
    const keywordsTrimmed = (seoKeywords || "").trim();

    if (!keywordsTrimmed) {
      console.warn(`${LOG_PREFIX} keywords empty`, { productId: productIdStr });
      return res.status(400).json({ error: "Palavras-chave SEO são obrigatórias", code: "SEO_KEYWORDS_REQUIRED" });
    }

    const rawVariant = variantKey === null || variantKey === undefined ? null : String(variantKey);
    const variantKeyVal = rawVariant === "" ? null : rawVariant;
    const isAllScopes = variantKeyVal === ALL_SCOPES;

    let query = supabase
      .from("product_image_links")
      .select("id, storage_path, file_name, sort_order, variant_key")
      .eq("user_id", user.id)
      .eq("product_id", productIdStr)
      .is("draft_key", null);

    if (!isAllScopes) {
      if (variantKeyVal === null) {
        query = query.is("variant_key", null);
      } else {
        query = query.eq("variant_key", variantKeyVal);
      }
    }

    const { data: links, error: linksError } = await query.order("variant_key", { ascending: true, nullsFirst: true }).order("sort_order", { ascending: true });

    if (linksError) {
      console.error(`${LOG_PREFIX} listLinks error`, linksError);
      return res.status(500).json({ error: "Erro ao listar imagens", code: "DB_ERROR" });
    }

    if (!links?.length) {
      return res.status(200).json({ ok: true, renamed: 0, failed: 0, details: [], message: "Nenhuma imagem no escopo" });
    }

    const productSlug = slugify(productName) || "produto";
    const firstKeyword = keywordsTrimmed.split(",")[0]?.trim() || "seo";
    const keywordsSlug = slugify(firstKeyword);

    const basePath = `${user.id}/${productIdStr}`;
    const copied = [];
    const details = [];

    console.log(`${LOG_PREFIX} start`, { productId: productIdStr, variantKey: isAllScopes ? ALL_SCOPES : variantKeyVal, count: links.length });

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const oldPath = link.storage_path;
      const ext = getExt(link.file_name || oldPath);
      const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const newFileName = buildNewFileName(productSlug, keywordsSlug, i + 1, ext, uniq);
      const newPath = `${basePath}/${newFileName}`;

      const { error: copyError } = await supabase.storage.from(BUCKET).copy(oldPath, newPath);

      if (copyError) {
        console.error(`${LOG_PREFIX} copy failed`, { oldPath, newPath, error: copyError.message });
        if (copied.length) {
          await supabase.storage.from(BUCKET).remove(copied);
        }
        return res.status(500).json({
          error: "Falha ao copiar no storage",
          code: "STORAGE_COPY_FAILED",
          details: copyError.message,
        });
      }

      copied.push(newPath);
      details.push({ id: link.id, oldPath, newPath, newFileName });
    }

    for (const u of details) {
      const { error: updateError } = await supabase
        .from("product_image_links")
        .update({ storage_path: u.newPath, file_name: u.newFileName })
        .eq("id", u.id)
        .eq("user_id", user.id);

      if (updateError) {
        console.error(`${LOG_PREFIX} DB update failed`, updateError);
        if (copied.length) {
          await supabase.storage.from(BUCKET).remove(copied);
        }
        return res.status(500).json({
          error: "Falha ao atualizar banco",
          code: "DB_UPDATE_FAILED",
          details: updateError.message,
        });
      }
    }

    const oldPaths = links.map((l) => l.storage_path);
    const { error: removeError } = await supabase.storage.from(BUCKET).remove(oldPaths);
    if (removeError) {
      console.warn(`${LOG_PREFIX} cleanup old paths failed (best-effort)`, removeError.message);
    }

    console.log(`${LOG_PREFIX} ok`, { renamed: details.length });

    return res.status(200).json({
      ok: true,
      renamed: details.length,
      failed: 0,
      details: details.map((d) => ({ id: d.id, newPath: d.newPath, newFileName: d.newFileName })),
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} fail`, err);
    return res.status(500).json({ error: "Erro interno", code: "INTERNAL_ERROR" });
  }
}
