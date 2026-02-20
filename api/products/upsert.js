// ======================================================================
// POST /api/products/upsert — Cria ou atualiza produto
// Regra de negócio: produto salvo como "variants" NÃO pode voltar para "simple"
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";

const ALLOWED_ORIGINS = [
  "https://suse7.com.br",
  "http://localhost:5173",
  ...(config.corsAllowedOrigins || []),
].filter(Boolean);

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
      return res.status(401).json({ error: "Token inválido", code: "UNAUTHORIZED" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { product, mode = "create" } = body;
    const productId = product?.id;

    if (!product) {
      return res.status(400).json({ error: "product é obrigatório", code: "INVALID_INPUT" });
    }

    const newFormat = (product.format || "simple").toLowerCase();
    const isUpdate = mode === "edit" && productId;

    // Regra: produto salvo como "variants" NÃO pode voltar para "simple"
    if (isUpdate && newFormat === "simple") {
      const { data: existing, error: fetchError } = await supabase
        .from("products")
        .select("id, format, user_id")
        .eq("id", productId)
        .eq("user_id", user.id)
        .single();

      if (fetchError || !existing) {
        return res.status(404).json({ error: "Produto não encontrado", code: "PRODUCT_NOT_FOUND" });
      }

      const currentFormat = (existing.format || "simple").toLowerCase();
      if (currentFormat === "variants") {
        return res.status(409).json({
          error: "Não é permitido converter um produto com variações para simples.",
          code: "FORMAT_LOCK_VARIATIONS",
        });
      }
    }

    // Placeholder: a persistência real (insert/update) será implementada
    // quando o frontend integrar. Por ora, retornamos ok para não quebrar.
    return res.status(200).json({
      ok: true,
      productId: productId || null,
      message: "Validação de formato concluída",
    });
  } catch (err) {
    console.error("[products/upsert] fail", err);
    return res.status(500).json({ error: "Erro interno", code: "INTERNAL_ERROR" });
  }
}
