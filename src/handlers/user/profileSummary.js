// ==================================================
// GET /api/user/profile-summary — nome/logo do layout (sem REST direto no browser)
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
function resolveDisplayName(row) {
  if (!row || typeof row !== "object") return null;
  const pick = (key) => {
    const v = row[key];
    return v != null && String(v).trim() !== "" ? String(v).trim() : null;
  };
  return (
    pick("account_alias") ??
    pick("nome_loja") ??
    pick("name") ??
    pick("account_name") ??
    pick("official_name") ??
    pick("ml_nickname") ??
    null
  );
}

export async function handleUserProfileSummary(req, res) {
  if (req.method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, getTraceId(req));
  }

  const traceId = getTraceId(req);

  try {
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      return ok(res, { ok: true, nome_loja: null, photo_url: null, display_name: null });
    }

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

    const { data, error } = await supabase
      .from("profiles")
      .select("nome_loja, photo_url, account_alias, ml_nickname")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      const msg = String(error.message ?? "").toLowerCase();
      if (msg.includes("column") || String(error.code ?? "") === "42703") {
        const { data: fallback, error: fbErr } = await supabase
          .from("profiles")
          .select("nome_loja, photo_url")
          .eq("id", user.id)
          .maybeSingle();
        if (fbErr) {
          console.error("[Suse7][API][user-profile-summary] failed", {
            message: fbErr.message,
            code: fbErr.code,
          });
          return ok(res, { ok: true, nome_loja: null, photo_url: null, display_name: null });
        }
        const displayName = resolveDisplayName(fallback);
        return ok(res, {
          ok: true,
          nome_loja: fallback?.nome_loja ?? displayName,
          photo_url: fallback?.photo_url ?? null,
          display_name: displayName,
        });
      }
      console.error("[Suse7][API][user-profile-summary] failed", {
        message: error.message,
        code: error.code,
      });
      return ok(res, { ok: true, nome_loja: null, photo_url: null, display_name: null });
    }

    const displayName = resolveDisplayName(data);
    const nomeLoja =
      data?.nome_loja != null && String(data.nome_loja).trim() !== ""
        ? String(data.nome_loja).trim()
        : displayName;

    return ok(res, {
      ok: true,
      nome_loja: nomeLoja,
      photo_url: data?.photo_url ?? null,
      display_name: displayName,
    });
  } catch (err) {
    console.error("[Suse7][API][user-profile-summary] failed", {
      message: err?.message ?? String(err),
    });
    return ok(res, { ok: true, nome_loja: null, photo_url: null, display_name: null });
  }
}
