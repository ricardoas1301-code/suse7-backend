// ======================================================================
// POST /api/drafts/upsert — Persiste metadados de draft (product_name, seo_keywords)
// Usado antes de SEO rename para drafts: backend lê sempre do DB
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";
import { applyCors } from "../../src/middlewares/cors.js";

export default async function handler(req, res) {
  const finished = applyCors(req, res);
  if (finished) return;

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
    const { draftKey, productName = "", seoKeywords = "" } = body;

    const draftKeyStr = draftKey != null ? String(draftKey).trim() : "";
    if (!draftKeyStr) {
      return res.status(400).json({ error: "draftKey é obrigatório", code: "INVALID_INPUT" });
    }

    const { error: upsertError } = await supabase
      .from("product_drafts")
      .upsert(
        {
          draft_key: draftKeyStr,
          user_id: user.id,
          product_name: String(productName || "").trim(),
          seo_keywords: String(seoKeywords || "").trim(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "draft_key,user_id" }
      );

    if (upsertError) {
      console.error("[drafts/upsert] error:", upsertError);
      return res.status(500).json({ error: "Falha ao salvar draft", code: "DB_ERROR" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[drafts/upsert] fail", err);
    return res.status(500).json({ error: "Erro interno", code: "INTERNAL_ERROR" });
  }
}
