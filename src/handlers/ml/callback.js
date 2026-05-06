// ======================================================
// /api/ml/callback — RECEBE code + state (token seguro)
// Objetivo:
// - Resolver state -> user_id via oauth_states
// - Trocar code por token no Mercado Livre
// - Buscar dados do seller (GET /users/me) para capturar nickname
// - Salvar tokens + ml_nickname no Supabase (ml_tokens)
// - Upsert em marketplace_accounts (multiconta + external_seller_id idempotente)
// - Redirecionar para /perfil/integracoes/mercado-livre?ml=connected&connected=1&ml_account=<uuid>
//
// Persistência: createClient com SUPABASE_SERVICE_ROLE_KEY (bypass RLS).
// Se upsert(onConflict) falhar (índice/constraint incompatível com PostgREST),
// fallback explícito: UPDATE por (user_id, marketplace) ou INSERT.
//
// Redirect final:
// - Usa FRONTEND_URL do ambiente (DEV: ex. http://localhost:5173 | PROD: https://suse7.com.br)
// - Validação explícita evita redirect silencioso para URL inválida ou placeholder
// ======================================================

import { createClient } from "@supabase/supabase-js";
import {
  resolveAndConsumeOAuthState,
  validateEnv,
  validateMlConnectOAuthEnv,
} from "./_helpers/oauthConnect.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import { config } from "../../infra/config.js";
import { sendRedirect } from "../../infra/httpRedirect.js";

const ML_CALLBACK_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ML_CLIENT_ID",
  "ML_CLIENT_SECRET",
  "ML_REDIRECT_URI",
  "FRONTEND_URL",
];

// ======================================================
// Helpers — URL base do frontend (redirect pós-OAuth)
// ======================================================

/**
 * Remove espaços e barras finais da URL base (sem alterar path interno).
 */
function sanitizeFrontendBaseUrl(value) {
  if (value == null) return "";
  const trimmed = String(value).trim();
  return trimmed.replace(/\/+$/, "");
}

/**
 * Detecta valores típicos de tutorial / .env de exemplo que não devem ir para produção.
 */
function isPlaceholderFrontendUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return true;
  const lower = s.toLowerCase().replace(/_/g, "-");

  if (/url-exata-do-frontend/i.test(lower)) return true;
  if (/url-real-do-frontend/i.test(lower)) return true;
  if (lower.includes("placeholder-frontend")) return true;
  if (lower.includes("your-frontend-url")) return true;
  if (lower.includes("troque-por-sua-url")) return true;

  return false;
}

/**
 * Valida FRONTEND_URL para uso em res.redirect.
 * Exige esquema http(s) e URL parseável; rejeita placeholders óbvios.
 *
 * @returns {{ ok: true, base: string } | { ok: false, reason: string }}
 */
function resolveValidatedFrontendBaseUrl(raw) {
  const sanitized = sanitizeFrontendBaseUrl(raw);

  if (!sanitized) {
    return { ok: false, reason: "FRONTEND_URL ausente ou vazia após trim" };
  }

  if (!/^https?:\/\//i.test(sanitized)) {
    return {
      ok: false,
      reason: "FRONTEND_URL deve começar com http:// ou https://",
    };
  }

  if (isPlaceholderFrontendUrl(sanitized)) {
    return {
      ok: false,
      reason:
        "FRONTEND_URL parece placeholder de documentação; defina a URL real do frontend deste ambiente",
    };
  }

  try {
    const parsed = new URL(sanitized);
    if (!parsed.hostname || parsed.hostname.length < 1) {
      return { ok: false, reason: "FRONTEND_URL sem hostname válido" };
    }
  } catch {
    return { ok: false, reason: "FRONTEND_URL não é uma URL absoluta válida" };
  }

  return { ok: true, base: sanitized };
}

/**
 * Monta URL da tela de integração ML com query fixa.
 * @param {string} querySuffix - ex.: "ml_error=token" ou query já codificada
 */
function buildMlIntegrationRedirect(frontendBase, querySuffix) {
  const path = "/perfil/integracoes/mercado-livre";
  return `${frontendBase}${path}?${querySuffix}`;
}

const UUID_REGEX_CB =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve seller_company_id: valida UUID vindo do oauth_states; senão primeira empresa do usuário.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function resolveSellerCompanyIdForMlCallback(supabase, userId, candidateFromOAuth) {
  const cand =
    candidateFromOAuth != null && String(candidateFromOAuth).trim() !== ""
      ? String(candidateFromOAuth).trim()
      : "";
  if (cand && UUID_REGEX_CB.test(cand)) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select("id")
      .eq("id", cand)
      .eq("user_id", userId)
      .maybeSingle();
    if (!error && data?.id) return String(data.id);
  }

  const selectVariants = [
    "id, is_primary, created_at",
    "id, created_at",
  ];
  for (const sel of selectVariants) {
    const hasPrimary = sel.includes("is_primary");
    let q = supabase.from("seller_companies").select(sel).eq("user_id", userId);
    if (hasPrimary) q = q.order("is_primary", { ascending: false });
    q = q.order("created_at", { ascending: false }).limit(1);
    const { data: rows, error } = await q;
    if (error) {
      const shape =
        String(error?.code ?? "") === "42703" ||
        String(error?.message ?? "")
          .toLowerCase()
          .includes("column");
      if (shape) continue;
      return null;
    }
    const first = Array.isArray(rows) ? rows[0] : null;
    if (first?.id) return String(first.id);
    return null;
  }
  return null;
}

/** Schema DEV legado: coluna ausente / shape PostgREST (não confundir com violação de negócio). */
function isPostgrestSchemaShapeError(error) {
  const c = String(error?.code ?? "");
  const m = String(error?.message ?? "").toLowerCase();
  return c === "42703" || m.includes("column") || m.includes("does not exist");
}

/** Tentar insert mais “magro” (próxima variante): coluna inexistente, FK inválida, NOT NULL em coluna opcional. */
function isMarketplaceInsertTryNextVariant(error, variantIndex, totalVariants) {
  if (!error) return false;
  const c = String(error.code ?? "");
  if (isPostgrestSchemaShapeError(error)) return true;
  if (c === "23503") return true; // FK (ex.: seller_company_id inválido)
  if (c === "23502" && variantIndex < totalVariants - 1) return true; // NOT NULL — tenta variante sem colunas opcionais
  return false;
}

/** Remove chaves com valor null (evita enviar FK/colunas opcionais como null explícito). */
function omitNullKeys(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v != null));
}

/**
 * Atualiza colunas opcionais após insert mínimo (ignora erro de coluna ausente).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function enrichMarketplaceAccountRow(supabase, accountId, nick, tokenExpiresAt) {
  const nowIso = new Date().toISOString();
  /** @type {Record<string, unknown>[]} */
  const attempts = [
    { ml_nickname: nick, account_alias: nick, token_expires_at: tokenExpiresAt, updated_at: nowIso },
    { token_expires_at: tokenExpiresAt, updated_at: nowIso },
    { ml_nickname: nick, account_alias: nick, updated_at: nowIso },
  ];
  for (const patch of attempts) {
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v != null && v !== "")
    );
    if (Object.keys(clean).length === 0) continue;
    const { error } = await supabase.from("marketplace_accounts").update(clean).eq("id", accountId);
    if (!error) return;
    if (!isPostgrestSchemaShapeError(error)) {
      logSupabasePersistError("marketplace_account_enrich", error);
      return;
    }
  }
}

/**
 * Upsert idempotente: (user_id + marketplace + external_seller_id). Preserva seller_company_id existente.
 * Fallback de colunas para DEV com schema atrás do código.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function upsertMercadoLivreMarketplaceAccount(supabase, ctx) {
  const {
    userId,
    marketplace,
    externalSellerId,
    sellerCompanyIdCandidate,
    mlNickname,
    tokenExpiresAt,
  } = ctx;
  const ext = String(externalSellerId || "").trim();
  const nowIso = new Date().toISOString();
  const nick =
    mlNickname != null && String(mlNickname).trim() !== "" ? String(mlNickname).trim() : null;

  const { data: existing, error: selErr } = await supabase
    .from("marketplace_accounts")
    .select("id, seller_company_id")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("external_seller_id", ext)
    .maybeSingle();

  if (selErr) {
    logSupabasePersistError("marketplace_account_select", selErr);
    return { ok: false, error: selErr, accountId: null };
  }

  const mergeSellerCompany = (prevRow, incomingResolved) => {
    const prev =
      prevRow?.seller_company_id != null && String(prevRow.seller_company_id).trim() !== ""
        ? String(prevRow.seller_company_id).trim()
        : null;
    const inc =
      incomingResolved != null && String(incomingResolved).trim() !== ""
        ? String(incomingResolved).trim()
        : null;
    if (prev) return prev;
    return inc;
  };

  if (existing?.id) {
    const sellerCo = mergeSellerCompany(existing, sellerCompanyIdCandidate);
    /** @type {Record<string, unknown>} */
    const patch = {
      ml_nickname: nick,
      account_alias: nick,
      token_expires_at: tokenExpiresAt,
      status: "active",
      updated_at: nowIso,
    };
    if (sellerCo) {
      patch.seller_company_id = sellerCo;
    }

    let { error: upErr } = await supabase.from("marketplace_accounts").update(patch).eq("id", existing.id);

    if (upErr && isPostgrestSchemaShapeError(upErr)) {
      const lean = { status: "active", updated_at: nowIso };
      if (sellerCo) lean.seller_company_id = sellerCo;
      const r2 = await supabase.from("marketplace_accounts").update(lean).eq("id", existing.id);
      upErr = r2.error;
    }

    if (upErr) {
      logSupabasePersistError("marketplace_account_update", upErr);
      return { ok: false, error: upErr, accountId: null };
    }
    await enrichMarketplaceAccountRow(supabase, String(existing.id), nick, tokenExpiresAt);
    console.log("[ml/callback] marketplace_account_upsert_ok", { via: "update", id: existing.id });
    return { ok: true, accountId: String(existing.id), created: false };
  }

  /** @type {Record<string, unknown>[]} */
  const insertVariants = [
    omitNullKeys({
      user_id: userId,
      marketplace,
      external_seller_id: ext,
      seller_company_id: sellerCompanyIdCandidate ?? null,
      ml_nickname: nick,
      account_alias: nick,
      status: "active",
      token_expires_at: tokenExpiresAt,
      updated_at: nowIso,
    }),
    omitNullKeys({
      user_id: userId,
      marketplace,
      external_seller_id: ext,
      seller_company_id: sellerCompanyIdCandidate ?? null,
      status: "active",
      updated_at: nowIso,
    }),
    omitNullKeys({
      user_id: userId,
      marketplace,
      external_seller_id: ext,
      status: "active",
      updated_at: nowIso,
    }),
  ];

  let lastInsErr = null;
  const nVar = insertVariants.length;
  for (let vi = 0; vi < nVar; vi++) {
    const insertRow = insertVariants[vi];
    const { data: inserted, error: insErr } = await supabase
      .from("marketplace_accounts")
      .insert(insertRow)
      .select("id")
      .single();

    if (!insErr && inserted?.id) {
      await enrichMarketplaceAccountRow(supabase, String(inserted.id), nick, tokenExpiresAt);
      console.log("[ml/callback] marketplace_account_upsert_ok", {
        via: "insert",
        id: inserted.id,
        insert_variant: vi,
      });
      return { ok: true, accountId: String(inserted.id), created: true };
    }

    lastInsErr = insErr;
    if (insErr && String(insErr.code) === "23505") {
      const { data: dupRow, error: dupErr } = await supabase
        .from("marketplace_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("external_seller_id", ext)
        .maybeSingle();
      if (!dupErr && dupRow?.id) {
        console.warn("[ml/callback] marketplace_account_insert_unique_race_recover", {
          variant: vi,
          id: dupRow.id,
        });
        await enrichMarketplaceAccountRow(supabase, String(dupRow.id), nick, tokenExpiresAt);
        return { ok: true, accountId: String(dupRow.id), created: false };
      }
    }

    if (insErr && isMarketplaceInsertTryNextVariant(insErr, vi, nVar)) {
      console.warn("[ml/callback] marketplace_account_insert_try_next_variant", {
        variant: vi,
        message: insErr.message,
        code: insErr.code,
        constraint: insErr.constraint ?? null,
      });
      continue;
    }
    if (insErr) {
      logSupabasePersistError("marketplace_account_insert", insErr);
      return { ok: false, error: insErr, accountId: null };
    }
  }

  if (lastInsErr) {
    logSupabasePersistError("marketplace_account_insert_all_variants", lastInsErr);
    return { ok: false, error: lastInsErr, accountId: null };
  }
  return { ok: false, error: new Error("marketplace_account_insert_no_id"), accountId: null };
}

/**
 * Log estruturado de erro PostgREST / Supabase (diagnóstico persistência).
 */
function logSupabasePersistError(context, err) {
  const e = err && typeof err === "object" ? err : { message: String(err) };
  console.error("[ml/callback] supabase_error", context, {
    message: e.message ?? null,
    code: e.code ?? null,
    details: e.details ?? null,
    hint: e.hint ?? null,
    // PostgREST / pg
    constraint: e.constraint ?? e?.cause ?? null,
  });
}

/**
 * Payload enviado ao banco sem vazar tokens completos.
 */
function summarizeMlTokensRowForLog(row) {
  if (!row || typeof row !== "object") return {};
  const at = row.access_token;
  const rt = row.refresh_token;
  return {
    user_id: row.user_id,
    marketplace: row.marketplace,
    ml_user_id: row.ml_user_id,
    ml_nickname: row.ml_nickname,
    expires_at: row.expires_at,
    expires_in: row.expires_in,
    scope: row.scope,
    token_type: row.token_type,
    access_token_prefix: typeof at === "string" ? `${at.slice(0, 14)}…` : null,
    refresh_token_present: typeof rt === "string" && rt.length > 0,
  };
}

/**
 * Cliente Supabase com service role (nunca anon key).
 */
function createServiceRoleSupabase() {
  const url = config.supabaseUrl?.trim();
  const key = config.supabaseServiceRoleKey?.trim();
  if (!url || !key) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes em config");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Persiste ml_tokens: tenta upsert; em falha, update ou insert manual.
 */
async function persistMlTokens(supabase, row) {
  const logSummary = summarizeMlTokensRowForLog(row);

  console.log("[ml/callback] persist_ml_tokens_start", {
    strategy: "upsert",
    onConflict: "user_id,marketplace",
    payload_summary: logSummary,
  });

  const upsertResult = await supabase
    .from("ml_tokens")
    .upsert(row, { onConflict: "user_id,marketplace" })
    .select("id, user_id, marketplace, updated_at");

  if (!upsertResult.error) {
    console.log("[ml/callback] persist_ml_tokens_ok", {
      via: "upsert",
      rows_returned: upsertResult.data?.length ?? 0,
      first: upsertResult.data?.[0] ?? null,
    });
    return { ok: true };
  }

  logSupabasePersistError("persist_tokens_upsert_failed", upsertResult.error);

  console.warn("[ml/callback] persist_ml_tokens_fallback", {
    reason: "upsert_failed_trying_update_then_insert",
  });

  const { data: existing, error: selErr } = await supabase
    .from("ml_tokens")
    .select("id")
    .eq("user_id", row.user_id)
    .eq("marketplace", row.marketplace)
    .maybeSingle();

  if (selErr) {
    logSupabasePersistError("persist_tokens_select_existing_failed", selErr);
    return { ok: false, error: selErr };
  }

  if (existing?.id) {
    const { data: updated, error: updErr } = await supabase
      .from("ml_tokens")
      .update({
        ml_user_id: row.ml_user_id,
        ml_nickname: row.ml_nickname,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_in: row.expires_in,
        expires_at: row.expires_at,
        scope: row.scope,
        token_type: row.token_type,
        updated_at: row.updated_at,
      })
      .eq("user_id", row.user_id)
      .eq("marketplace", row.marketplace)
      .select("id, updated_at");

    if (updErr) {
      logSupabasePersistError("persist_tokens_update_failed", updErr);
      return { ok: false, error: updErr };
    }

    console.log("[ml/callback] persist_ml_tokens_ok", {
      via: "update",
      rows: updated?.length ?? 0,
      first: updated?.[0] ?? null,
    });
    return { ok: true };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("ml_tokens")
    .insert(row)
    .select("id, user_id, marketplace, updated_at");

  if (insErr) {
    logSupabasePersistError("persist_tokens_insert_failed", insErr);
    return { ok: false, error: insErr };
  }

  console.log("[ml/callback] persist_ml_tokens_ok", {
    via: "insert",
    rows_returned: inserted?.length ?? 0,
    first: inserted?.[0] ?? null,
  });
  return { ok: true };
}

// ======================================================
// Handler principal
// ======================================================

async function handleMLCallback(req, res) {
  const errorId = Date.now();
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    console.log("[ml/callback] EXECUTADO", new Date().toISOString());
    console.info("[ml/callback] build_fingerprint", {
      marketplace_account_upsert_v: "schema_fallback_v3_fk_notnull_unique",
      vercel_git_commit: process.env.VERCEL_GIT_COMMIT ?? null,
      vercel_deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    });
    console.log("[ml/callback] req.query.code present?", !!req.query?.code);
    console.log("[ml/callback] req.query.state present?", !!req.query?.state);

    const code = req.query?.code;
    const state = req.query?.state;

    if (!code) {
      return res.status(400).json({ ok: false, error: "Code não encontrado" });
    }

    if (!state) {
      return res.status(400).json({ ok: false, error: "State não encontrado" });
    }

    {
      const ruProbe = process.env.ML_REDIRECT_URI?.trim() ?? "";
      const stStr = typeof state === "string" ? state : String(state);
      console.info("[ML_AUTH] callback_target", {
        redirectUri: ruProbe,
        statePreview: stStr.length > 16 ? `${stStr.slice(0, 10)}…` : stStr,
        host: req.headers?.host ?? null,
      });
    }

    // ------------------------------
    // ENV obrigatórias
    // ------------------------------
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    if (!envCheck.ok) {
      const msg = `Missing env: ${envCheck.missing.join(", ")}`;
      console.error("[ml/callback] errorId:", errorId, { missingEnv: envCheck.missing });
      return res.status(500).json({
        ok: false,
        error: msg,
        errorId,
      });
    }

    const mlOAuth = validateMlConnectOAuthEnv(req);
    if (!mlOAuth.ok) {
      console.error("[ml/callback] invalid_ml_oauth_env", { errorId, errors: mlOAuth.errors });
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth do Mercado Livre inválida no servidor",
        errorId,
        details: mlOAuth.errors,
      });
    }

    console.log("[ml/callback] supabase_client", {
      supabase_url_host: (() => {
        try {
          return new URL(config.supabaseUrl).hostname;
        } catch {
          return "(invalid_url)";
        }
      })(),
      service_role_key_prefix: config.supabaseServiceRoleKey
        ? `${String(config.supabaseServiceRoleKey).slice(0, 12)}…`
        : "(missing)",
    });

    // ------------------------------
    // FRONTEND_URL: validar ANTES de consumir state / trocar code
    // (evita perder state e deixar usuário sem redirect utilizável)
    // ------------------------------
    const frontendResolution = resolveValidatedFrontendBaseUrl(process.env.FRONTEND_URL);
    if (!frontendResolution.ok) {
      console.error("[ml/callback] FRONTEND_URL inválida — não redirecionando", {
        errorId,
        reason: frontendResolution.reason,
        rawLength: process.env.FRONTEND_URL?.length ?? 0,
        rawPreview: (() => {
          const r = String(process.env.FRONTEND_URL || "");
          if (!r) return "(empty)";
          return r.length > 80 ? `${r.slice(0, 80)}…` : r;
        })(),
      });
      return res.status(500).json({
        ok: false,
        error: "FRONTEND_URL inválida no ambiente atual",
        detail: frontendResolution.reason,
        errorId,
      });
    }

    const frontendBase = frontendResolution.base;

    // ------------------------------
    // State OAuth (one-time) — mesmo service role
    // ------------------------------
    const oauthCtx = await resolveAndConsumeOAuthState(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      state,
      "ml"
    );

    const supabaseUserId = oauthCtx?.user_id ?? null;
    const sellerCompanyIdFromOAuthState = oauthCtx?.seller_company_id ?? null;

    if (!supabaseUserId) {
      console.error("[ml/callback] step_failed: resolve_state", { state });
      return res.status(401).json({ ok: false, error: "Invalid/expired state" });
    }

    const supabase = createServiceRoleSupabase();

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", supabaseUserId)
      .maybeSingle();

    if (profileError || !profile) {
      console.error("❌ Usuário inválido no callback ML:", supabaseUserId);
      return res.status(401).json({ error: "Usuário inválido para este state" });
    }

    const redirectUri = process.env.ML_REDIRECT_URI?.trim();
    if (!redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "ML_REDIRECT_URI não configurada",
        errorId,
      });
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ML_CLIENT_ID.trim(),
      client_secret: process.env.ML_CLIENT_SECRET.trim(),
      code: typeof code === "string" ? code : String(code),
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    const rawTokenText = await tokenResponse.text();
    /** @type {Record<string, unknown>} */
    let mlData = {};
    try {
      mlData = rawTokenText ? JSON.parse(rawTokenText) : {};
    } catch {
      mlData = { _raw: rawTokenText?.slice?.(0, 500) ?? "" };
    }

    if (!tokenResponse.ok || !mlData.access_token) {
      console.error("[ml/callback] step_failed: exchange_code", {
        http_status: tokenResponse.status,
        ml_error: mlData.error ?? null,
        ml_message: mlData.message ?? mlData.cause ?? null,
        body_preview: typeof rawTokenText === "string" ? rawTokenText.slice(0, 400) : null,
      });
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=token"), 302);
      return;
    }

    const expiresAt = new Date(Date.now() + mlData.expires_in * 1000).toISOString();

    let mlNickname = null;

    try {
      const meResponse = await fetch("https://api.mercadolibre.com/users/me", {
        headers: {
          Authorization: `Bearer ${mlData.access_token}`,
        },
      });

      if (meResponse.ok) {
        const meData = await meResponse.json();
        mlNickname = meData?.nickname || null;
        console.log("✅ ML nickname capturado:", mlNickname);
      } else {
        console.warn("⚠️ Falha ao buscar /users/me:", meResponse.status);
      }
    } catch (meErr) {
      console.warn("⚠️ Erro ao buscar /users/me (ignorado):", meErr?.message);
    }

    const mlUserIdForRow =
      mlData.user_id != null && mlData.user_id !== "" ? String(mlData.user_id) : "";
    if (!mlUserIdForRow) {
      console.error("[ml/callback] step_failed: ml_user_id_missing_from_token_response", {
        keys: Object.keys(mlData || {}),
      });
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=token"), 302);
      return;
    }

    const row = {
      user_id: supabaseUserId,
      marketplace: ML_MARKETPLACE_SLUG,
      ml_user_id: mlUserIdForRow,
      ml_nickname: mlNickname,
      access_token: mlData.access_token,
      refresh_token: mlData.refresh_token ?? null,
      expires_in: mlData.expires_in,
      expires_at: expiresAt,
      scope: mlData.scope ?? "",
      token_type: mlData.token_type ?? "bearer",
      updated_at: new Date().toISOString(),
    };

    if (!row.refresh_token) {
      console.warn("[ml/callback] ml_refresh_token_absent", {
        user_id: supabaseUserId,
        marketplace: ML_MARKETPLACE_SLUG,
      });
    }

    const persist = await persistMlTokens(supabase, row);

    if (!persist.ok) {
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=save"), 302);
      return;
    }

    const resolvedSellerCompanyId = await resolveSellerCompanyIdForMlCallback(
      supabase,
      supabaseUserId,
      sellerCompanyIdFromOAuthState
    );

    console.info("[ml/callback] marketplace_account_context", {
      errorId,
      user_id: supabaseUserId,
      external_seller_id: mlUserIdForRow,
      seller_company_from_oauth_state: sellerCompanyIdFromOAuthState ? "set" : "absent",
      seller_company_resolved: Boolean(resolvedSellerCompanyId),
    });
    if (!resolvedSellerCompanyId) {
      console.warn("[ml/callback] marketplace_account_warn_no_seller_company_id", {
        errorId,
        user_id: supabaseUserId,
        hint: "Nenhuma seller_companies para o usuário; insert pode falhar se a coluna for NOT NULL.",
      });
    }

    const accResult = await upsertMercadoLivreMarketplaceAccount(supabase, {
      userId: supabaseUserId,
      marketplace: ML_MARKETPLACE_SLUG,
      externalSellerId: mlUserIdForRow,
      sellerCompanyIdCandidate: resolvedSellerCompanyId,
      mlNickname,
      tokenExpiresAt: expiresAt,
    });

    if (!accResult.ok || !accResult.accountId) {
      const er = accResult.error && typeof accResult.error === "object" ? accResult.error : {};
      console.error("[ml/callback] step_failed: marketplace_account_upsert", {
        errorId,
        message: er.message ?? accResult.error,
        code: er.code ?? null,
        constraint: er.constraint ?? null,
        details: er.details ?? null,
      });
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=save"), 302);
      return;
    }

    const q = new URLSearchParams({
      ml: "connected",
      connected: "1",
      ml_account: accResult.accountId,
    });
    const successUrl = buildMlIntegrationRedirect(frontendBase, q.toString());
    console.log("[ml/callback] redirect sucesso → integração ML", {
      errorId,
      host: new URL(frontendBase).hostname,
      marketplace_account_id: accResult.accountId,
    });
    sendRedirect(res, successUrl, 302);
    return;
  } catch (err) {
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    console.error("[ml/callback] errorId:", errorId, {
      message: err?.message,
      stack: err?.stack,
      missingEnv: envCheck.missing,
    });

    const diagnosticMsg = envCheck.ok
      ? err?.message || "Erro interno no callback ML"
      : `Missing env: ${envCheck.missing.join(", ")}`;

    return res.status(500).json({
      ok: false,
      error: diagnosticMsg,
      errorId,
    });
  }
}

export default handleMLCallback;
