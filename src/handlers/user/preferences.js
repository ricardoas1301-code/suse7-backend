// ==================================================
// SUSE7 — Handler: User Preferences
// Arquivo: src/handlers/user/preferences.js
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import {
  normalizeKey,
  validateKey,
  upsertPreference,
  getPreferences,
} from "../../domain/UserPreferencesDomainService.js";
import { recordAuditEvent } from "../../infra/auditService.js";

export async function handleUserPreferences(req, res) {
  if (!["GET", "PUT", "DELETE"].includes(req.method)) {
    const traceId = getTraceId(req);
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  const traceId = getTraceId(req);

  try {
    // Valida config Supabase (evita 500 por env vars ausentes; mesmo critério de notifications)
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      console.error("[Suse7][API][user-preferences] failed", {
        message: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente",
      });
      return ok(res, { ok: true, preferences: {} });
    }

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
      const rawPrefix = req.query?.prefix;
      const prefixInput = rawPrefix != null ? String(rawPrefix).trim() : "";
      const sanitizedPrefix = prefixInput.replace(/\s+/g, "").replace(/[^a-zA-Z0-9_.-]/g, "");
      const prefix = sanitizedPrefix || null;

      const { data, error } = await getPreferences(supabase, user.id, prefix);

      if (error) {
        console.error("[Suse7][API][user-preferences] failed", {
          message: error?.message,
          code: error?.code,
          details: error?.details,
        });
        return ok(res, { ok: true, preferences: {} });
      }
      const rows = Array.isArray(data) ? data : [];
      const map = {};
      for (const row of rows) {
        if (row?.key == null || String(row.key).trim() === "") continue;
        map[String(row.key)] = row?.value ?? {};
      }
      return ok(res, { ok: true, preferences: map, preference_rows: rows });
    }

    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { key, value } = body;

      if (!key) {
        return fail(res, { code: "KEY_INVALID", message: "key é obrigatória" }, 400, traceId);
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

    if (req.method === "DELETE") {
      const keyParam = req.query?.key;

      if (!keyParam) {
        return fail(res, { code: "KEY_INVALID", message: "key é obrigatória (query)" }, 400, traceId);
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
        return fail(res, { code: "PREFERENCE_NOT_FOUND", message: "Preferência não encontrada" }, 404, traceId);
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
    console.error("[Suse7][API][user-preferences] failed", {
      message: err?.message,
      code: err?.code,
      details: err?.details,
    });
    return ok(res, { ok: true, preferences: {} });
  }
}
