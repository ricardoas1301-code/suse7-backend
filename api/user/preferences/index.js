// ======================================================================
// API /api/user/preferences — Preferências do usuário (modais, avisos)
// GET, PUT, DELETE
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../../src/infra/http.js";
import { setCorsHeaders, handlePreflight } from "../../../src/lib/cors.js";
import {
  normalizeKey,
  validateKey,
  upsertPreference,
  getPreferences,
} from "../../../src/domain/UserPreferencesDomainService.js";
import { recordAuditEvent } from "../../../src/infra/auditService.js";

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (!["GET", "PUT", "DELETE"].includes(req.method)) {
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

    // ------------------------------------------------------------------
    // GET — listar preferências (opcional: prefix)
    // ------------------------------------------------------------------
    if (req.method === "GET") {
      const urlParams = req.url?.split("?")[1] ? new URLSearchParams(req.url.split("?")[1]) : null;
      const prefix = urlParams?.get("prefix") || null;

      const { data, error } = await getPreferences(supabase, user.id, prefix);

      if (error) {
        console.error("[user/preferences] GET error:", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao listar preferências" }, 500, traceId);
      }

      return ok(res, { preferences: data });
    }

    // ------------------------------------------------------------------
    // PUT — upsert preferência
    // ------------------------------------------------------------------
    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { key, value } = body;

      if (!key) {
        return fail(
          res,
          { code: "KEY_INVALID", message: "key é obrigatória" },
          400,
          traceId
        );
      }

      const keyCheck = validateKey(key);
      if (!keyCheck.valid) {
        return fail(res, { code: keyCheck.code, message: keyCheck.message }, 400, traceId);
      }

      const normalizedKey = normalizeKey(key);

      const { data: existing } = await supabase
        .from("user_preferences")
        .select("id, value")
        .eq("user_id", user.id)
        .eq("key", normalizedKey)
        .maybeSingle();

      const { data, error } = await upsertPreference(supabase, user.id, normalizedKey, value ?? {});

      if (error) {
        console.error("[user/preferences] PUT error:", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao salvar preferência" }, 500, traceId);
      }

      try {
        await recordAuditEvent({
          userId: user.id,
          entityType: "user_preference",
          entityId: data.id,
          action: existing ? "update" : "create",
          diff: {
            before: existing ? { key: normalizedKey, value: existing.value } : null,
            after: { key: normalizedKey, value: data.value },
          },
          traceId,
        });
      } catch (auditErr) {
        console.error("[user/preferences] audit fail", auditErr);
      }

      return ok(res, { preference: data });
    }

    // ------------------------------------------------------------------
    // DELETE — remover preferência
    // ------------------------------------------------------------------
    if (req.method === "DELETE") {
      const urlParams = req.url?.split("?")[1] ? new URLSearchParams(req.url.split("?")[1]) : null;
      const keyParam = urlParams?.get("key");

      if (!keyParam) {
        return fail(
          res,
          { code: "KEY_INVALID", message: "key é obrigatória (query)" },
          400,
          traceId
        );
      }

      const keyCheck = validateKey(keyParam);
      if (!keyCheck.valid) {
        return fail(res, { code: keyCheck.code, message: keyCheck.message }, 400, traceId);
      }

      const normalizedKey = normalizeKey(keyParam);

      const { data: existing } = await supabase
        .from("user_preferences")
        .select("id, key, value")
        .eq("user_id", user.id)
        .eq("key", normalizedKey)
        .single();

      if (!existing) {
        return fail(
          res,
          { code: "PREFERENCE_NOT_FOUND", message: "Preferência não encontrada" },
          404,
          traceId
        );
      }

      const { error } = await supabase
        .from("user_preferences")
        .delete()
        .eq("id", existing.id)
        .eq("user_id", user.id);

      if (error) {
        console.error("[user/preferences] DELETE error:", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao remover preferência" }, 500, traceId);
      }

      try {
        await recordAuditEvent({
          userId: user.id,
          entityType: "user_preference",
          entityId: existing.id,
          action: "update",
          diff: { before: { key: existing.key, value: existing.value }, after: null },
          traceId,
        });
      } catch (auditErr) {
        console.error("[user/preferences] audit delete fail", auditErr);
      }

      return ok(res, { ok: true, message: "Preferência removida" });
    }
  } catch (err) {
    console.error("[user/preferences] fail", err);
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
