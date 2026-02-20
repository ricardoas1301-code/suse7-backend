// ======================================================================
// POST /api/images/seo-rename — Renomeia imagens do escopo com SEO
// Input: { scope: { product_id?, draft_key? }, variant_key?, mode? }
// Compatível com payload legado: { productId, variantKey? }
// product_id: product_name e seo_keywords do DB (products)
// draft_key: product_name e seo_keywords do body (obrigatórios)
// variant_key: null | string — null = produto simples, string = variação
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";

const BUCKET = "product-images";
const LOG_PREFIX = "[SEO_RENAME]";
const ALL_SCOPES = "__ALL__";

const ALLOWED_ORIGINS = [
  "https://suse7.com.br",
  "http://localhost:5173",
  ...(config.corsAllowedOrigins || []),
].filter(Boolean);

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

/**
 * Gera nome limpo: {keywordsSlug}-{index}.{ext}
 * Fallback incremental em caso de colisão: {keywordsSlug}-{index}-2.{ext}, etc.
 */
function findNextAvailableFileName(keywordsSlug, index, ext, takenNames) {
  const kw = keywordsSlug || "seo";
  const base = `${kw}-${index}.${ext}`;
  if (!takenNames.has(base)) return base;
  let suffix = 2;
  let candidate;
  do {
    candidate = `${kw}-${index}-${suffix}.${ext}`;
    suffix++;
  } while (takenNames.has(candidate));
  return candidate;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

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
    const { productId, variantKey, scope, variant_key, seo_keywords, product_name } = body;

    const productIdStr = (scope?.product_id ?? productId) && String(scope?.product_id ?? productId).trim();
    const draftKeyStr = scope?.draft_key && String(scope.draft_key).trim();

    if (!productIdStr && !draftKeyStr) {
      return res.status(400).json({ error: "scope.product_id ou scope.draft_key é obrigatório", code: "INVALID_INPUT" });
    }

    const variantKeyVal = (variant_key ?? variantKey) === null || (variant_key ?? variantKey) === undefined
      ? null
      : (String(variant_key ?? variantKey).trim() || null);

    const isAllScopes = variantKeyVal === ALL_SCOPES;

    let productName = "";
    let keywordsTrimmed = "";
    let basePath = "";
    let links = [];

    if (productIdStr) {
      const { data: product, error: productError } = await supabase
        .from("products")
        .select("product_name, seo_keywords, user_id")
        .eq("id", productIdStr)
        .eq("user_id", user.id)
        .single();

      if (productError || !product) {
        return res.status(404).json({ error: "Produto não encontrado", code: "PRODUCT_NOT_FOUND" });
      }

      productName = product.product_name || "";
      keywordsTrimmed = (product.seo_keywords || "").trim();

      if (!keywordsTrimmed) {
        console.warn(`${LOG_PREFIX} keywords empty`, { productId: productIdStr });
        return res.status(400).json({ error: "Palavras-chave SEO são obrigatórias", code: "SEO_KEYWORDS_REQUIRED" });
      }

      basePath = `${user.id}/${productIdStr}`;

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

      const { data: productLinks, error: linksError } = await query.order("variant_key", { ascending: true, nullsFirst: true }).order("sort_order", { ascending: true });
      if (linksError) {
        console.error(`${LOG_PREFIX} listLinks error`, linksError);
        return res.status(500).json({ error: "Erro ao listar imagens", code: "DB_ERROR" });
      }
      links = productLinks || [];
    } else {
      const kwRaw = seo_keywords;
      const kw = Array.isArray(kwRaw)
        ? kwRaw.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean).join(", ")
        : String(kwRaw ?? "").trim();
      const pn = (product_name ?? "").trim();
      if (!kw) {
        return res.status(400).json({ error: "Palavras-chave SEO são obrigatórias (draft)", code: "SEO_KEYWORDS_REQUIRED" });
      }
      productName = pn || "draft";
      keywordsTrimmed = kw;
      basePath = `${user.id}/${draftKeyStr}`;

      let query = supabase
        .from("product_image_links")
        .select("id, storage_path, file_name, sort_order, variant_key")
        .eq("user_id", user.id)
        .eq("draft_key", draftKeyStr)
        .is("product_id", null);

      if (!isAllScopes) {
        if (variantKeyVal === null) {
          query = query.is("variant_key", null);
        } else {
          query = query.eq("variant_key", variantKeyVal);
        }
      }

      const { data: draftLinks, error: linksError } = await query.order("variant_key", { ascending: true, nullsFirst: true }).order("sort_order", { ascending: true });
      if (linksError) {
        console.error(`${LOG_PREFIX} listLinks draft error`, linksError);
        return res.status(500).json({ error: "Erro ao listar imagens", code: "DB_ERROR" });
      }
      links = draftLinks || [];
    }

    if (!links?.length) {
      return res.status(200).json({ ok: true, renamed: 0, renamed_count: 0, failed: 0, details: [], message: "Nenhuma imagem no escopo" });
    }

    const tags = keywordsTrimmed.split(",").map((s) => s.trim()).filter(Boolean);
    const keywordsJoined = tags.length ? tags.join("-") : "seo";
    const keywordsSlug = slugify(keywordsJoined);

    const takenNames = new Set();
    const { data: existingFiles } = await supabase.storage.from(BUCKET).list(basePath);
    if (existingFiles?.length) {
      for (const f of existingFiles) {
        if (f?.name) takenNames.add(f.name);
      }
    }

    const copied = [];
    const details = [];

    console.log(`${LOG_PREFIX} start`, { productId: productIdStr, draftKey: draftKeyStr, variantKey: isAllScopes ? ALL_SCOPES : variantKeyVal, count: links.length });

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const oldPath = link.storage_path;
      const ext = getExt(link.file_name || oldPath);
      const newFileName = findNextAvailableFileName(keywordsSlug, i + 1, ext, takenNames);
      takenNames.add(newFileName);
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
        .update({ storage_path: u.newPath, file_name: u.newFileName, updated_at: new Date().toISOString() })
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

    const newFileNames = details.map((d) => d.newFileName);

    return res.status(200).json({
      ok: true,
      renamed: details.length,
      renamed_count: details.length,
      failed: 0,
      new_file_names: newFileNames,
      details: details.map((d) => ({ id: d.id, newPath: d.newPath, newFileName: d.newFileName })),
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} fail`, err);
    return res.status(500).json({ error: "Erro interno", code: "INTERNAL_ERROR" });
  }
}
