// ======================================================================
// API /api/products/ad-titles — Títulos de anúncios (CRUD)
// GET, POST, PATCH, DELETE — até 10 títulos por produto, sem duplicados
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import {
  normalizeTitle,
  normalizeTitleKey,
  validateTitleNotEmpty,
  validateNewTitleLimit,
  validateTitleNotDuplicate,
} from "../../domain/AdTitlesDomainService.js";
import { recordAuditEvent } from "../../infra/auditService.js";

async function ensureProductOwnership(supabase, userId, productId) {
  const { data, error } = await supabase
    .from("products")
    .select("id")
    .eq("id", productId)
    .eq("user_id", userId)
    .single();
  if (error || !data) return false;
  return true;
}

async function ensureAdTitleOwnership(supabase, userId, adTitleId) {
  const { data, error } = await supabase
    .from("product_ad_titles")
    .select("id, product_id, title, is_active, created_at, updated_at")
    .eq("id", adTitleId)
    .eq("user_id", userId)
    .single();
  if (error || !data) return null;
  return data;
}

export async function handleProductsAdTitles(req, res) {
  const traceId = getTraceId(req);

  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    return fail(
      res,
      { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" },
      405,
      traceId
    );
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

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token inválido" }, 401, traceId);
    }

    if (req.method === "GET") {
      const productId = req.query?.product_id || null;

      if (!productId) {
        return fail(
          res,
          { code: "INVALID_INPUT", message: "product_id é obrigatório" },
          400,
          traceId
        );
      }

      const owns = await ensureProductOwnership(supabase, user.id, productId);
      if (!owns) {
        return fail(
          res,
          { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" },
          404,
          traceId
        );
      }

      const { data, error } = await supabase
        .from("product_ad_titles")
        .select("id, product_id, title, is_active, created_at, updated_at")
        .eq("user_id", user.id)
        .eq("product_id", productId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("[ad-titles] GET error:", error);
        return fail(
          res,
          { code: "DB_ERROR", message: "Erro ao listar títulos" },
          500,
          traceId
        );
      }

      return ok(res, { titles: data || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { product_id, title } = body;

      if (!product_id || !title) {
        return fail(
          res,
          { code: "INVALID_INPUT", message: "product_id e title são obrigatórios" },
          400,
          traceId
        );
      }

      const owns = await ensureProductOwnership(supabase, user.id, product_id);
      if (!owns) {
        return fail(
          res,
          { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" },
          404,
          traceId
        );
      }

      const emptyCheck = validateTitleNotEmpty(title);
      if (!emptyCheck.valid) {
        return fail(res, { code: emptyCheck.code, message: emptyCheck.message }, 400, traceId);
      }

      const limitCheck = await validateNewTitleLimit(supabase, user.id, product_id);
      if (!limitCheck.valid) {
        return fail(
          res,
          { code: limitCheck.code, message: limitCheck.message, details: { count: limitCheck.count } },
          409,
          traceId
        );
      }

      const titleNorm = normalizeTitleKey(title);
      const dupCheck = await validateTitleNotDuplicate(supabase, user.id, product_id, titleNorm);
      if (!dupCheck.valid) {
        return fail(res, { code: dupCheck.code, message: dupCheck.message }, 409, traceId);
      }

      const titleNormDisplay = normalizeTitle(title);

      const { data: inserted, error } = await supabase
        .from("product_ad_titles")
        .insert({
          user_id: user.id,
          product_id,
          title: titleNormDisplay,
          title_normalized: titleNorm,
          is_active: true,
        })
        .select("id, product_id, title, is_active, created_at, updated_at")
        .single();

      if (error) {
        if (error.code === "23505") {
          return fail(
            res,
            { code: "TITLE_DUPLICATE", message: "Título duplicado para este produto." },
            409,
            traceId
          );
        }
        console.error("[ad-titles] POST error:", error);
        return fail(
          res,
          { code: "DB_ERROR", message: "Erro ao criar título" },
          500,
          traceId
        );
      }

      try {
        await recordAuditEvent({
          userId: user.id,
          entityType: "product_ad_title",
          entityId: inserted.id,
          action: "create",
          diff: { before: null, after: inserted },
          traceId,
        });
      } catch (auditErr) {
        console.error("[ad-titles] audit create fail", auditErr);
      }

      return ok(res, { title: inserted }, 201);
    }

    if (req.method === "PATCH") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { id, title, is_active } = body;

      if (!id) {
        return fail(
          res,
          { code: "INVALID_INPUT", message: "id é obrigatório" },
          400,
          traceId
        );
      }

      const existing = await ensureAdTitleOwnership(supabase, user.id, id);
      if (!existing) {
        return fail(
          res,
          { code: "TITLE_NOT_FOUND", message: "Título não encontrado" },
          404,
          traceId
        );
      }

      const updates = {};

      if (title !== undefined) {
        const emptyCheck = validateTitleNotEmpty(title);
        if (!emptyCheck.valid) {
          return fail(res, { code: emptyCheck.code, message: emptyCheck.message }, 400, traceId);
        }

        const titleNorm = normalizeTitleKey(title);
        const dupCheck = await validateTitleNotDuplicate(
          supabase,
          user.id,
          existing.product_id,
          titleNorm,
          id
        );
        if (!dupCheck.valid) {
          return fail(res, { code: dupCheck.code, message: dupCheck.message }, 409, traceId);
        }

        updates.title = normalizeTitle(title);
        updates.title_normalized = titleNorm;
      }

      if (is_active !== undefined) {
        updates.is_active = !!is_active;
      }

      if (Object.keys(updates).length === 0) {
        return fail(
          res,
          { code: "INVALID_INPUT", message: "Nenhum campo para atualizar (title ou is_active)" },
          400,
          traceId
        );
      }

      const { data: updated, error } = await supabase
        .from("product_ad_titles")
        .update(updates)
        .eq("id", id)
        .eq("user_id", user.id)
        .select("id, product_id, title, is_active, created_at, updated_at")
        .single();

      if (error) {
        if (error.code === "23505") {
          return fail(
            res,
            { code: "TITLE_DUPLICATE", message: "Título duplicado para este produto." },
            409,
            traceId
          );
        }
        console.error("[ad-titles] PATCH error:", error);
        return fail(
          res,
          { code: "DB_ERROR", message: "Erro ao atualizar título" },
          500,
          traceId
        );
      }

      try {
        await recordAuditEvent({
          userId: user.id,
          entityType: "product_ad_title",
          entityId: id,
          action: "update",
          diff: { before: existing, after: updated },
          traceId,
        });
      } catch (auditErr) {
        console.error("[ad-titles] audit update fail", auditErr);
      }

      return ok(res, { title: updated });
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;

      if (!id) {
        return fail(
          res,
          { code: "INVALID_INPUT", message: "id é obrigatório (query)" },
          400,
          traceId
        );
      }

      const existing = await ensureAdTitleOwnership(supabase, user.id, id);
      if (!existing) {
        return fail(
          res,
          { code: "TITLE_NOT_FOUND", message: "Título não encontrado" },
          404,
          traceId
        );
      }

      const { error } = await supabase
        .from("product_ad_titles")
        .delete()
        .eq("id", id)
        .eq("user_id", user.id);

      if (error) {
        console.error("[ad-titles] DELETE error:", error);
        return fail(
          res,
          { code: "DB_ERROR", message: "Erro ao remover título" },
          500,
          traceId
        );
      }

      try {
        await recordAuditEvent({
          userId: user.id,
          entityType: "product_ad_title",
          entityId: id,
          action: "update",
          diff: { before: existing, after: null },
          traceId,
        });
      } catch (auditErr) {
        console.error("[ad-titles] audit delete fail", auditErr);
      }

      return ok(res, { ok: true, message: "Título removido" });
    }
  } catch (err) {
    console.error("[ad-titles] fail", err);
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
