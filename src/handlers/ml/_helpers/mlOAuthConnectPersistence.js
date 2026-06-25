// ======================================================================
// Persistência pós-OAuth ML: ml_tokens + marketplace_accounts (service role).
// Usado pelo /api/ml/callback e reconciliação quando há token sem conta.
// Não logar access_token / refresh_token completos.
// ======================================================================

import { fetchMercadoLibreUserMe } from "./mercadoLibreOrdersApi.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { createMlInitialSyncJobsIfAbsent } from "../../../services/marketplace/createMlInitialSyncJobs.js";

const UUID_REGEX_CB =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ prohibitPrimaryFallback?: boolean }} [opts] — se true (fluxo additional_account), nunca cair na empresa principal.
 */
export async function resolveSellerCompanyIdForMlCallback(supabase, userId, candidateFromOAuth, opts = {}) {
  const prohibitPrimaryFallback = opts.prohibitPrimaryFallback === true;
  const uid = String(userId || "").trim();
  if (!uid) {
    console.info("[ml/callback] seller_company_resolved", { user_id: null, seller_company_id: null, reason: "empty_user_id" });
    return null;
  }

  const cand =
    candidateFromOAuth != null && String(candidateFromOAuth).trim() !== ""
      ? String(candidateFromOAuth).trim()
      : "";

  if (prohibitPrimaryFallback && (!cand || !UUID_REGEX_CB.test(cand))) {
    console.warn("[ml/callback] seller_company_required_additional_no_fallback", {
      user_id: uid,
      prohibit_primary_fallback: true,
      candidate_present: Boolean(cand),
    });
    return null;
  }

  if (cand && UUID_REGEX_CB.test(cand)) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select("id")
      .eq("id", cand)
      .eq("user_id", uid)
      .maybeSingle();
    if (!error && data?.id) {
      const sid = String(data.id);
      console.info("[ml/callback] seller_company_validated", { user_id: uid, seller_company_id: sid });
      return sid;
    }
    console.warn("[ml/callback] seller_company_state_invalid_no_fallback", {
      user_id: uid,
      seller_company_id_preview: `${cand.slice(0, 8)}…`,
      error_code: error?.code ?? null,
      error_message: error?.message ?? null,
      hint: "State OAuth trouxe seller_company_id que não existe para este user_id — não usar empresa principal.",
      prohibit_primary_fallback: prohibitPrimaryFallback,
    });
    return null;
  }

  if (cand) {
    console.warn("[ml/callback] seller_company_state_invalid_uuid", {
      user_id: uid,
      hint: "seller_company_id no state não é UUID válido.",
    });
    return null;
  }

  if (prohibitPrimaryFallback) {
    console.warn("[ml/callback] seller_company_additional_missing_candidate", {
      user_id: uid,
      hint: "additional_account exige seller_company_id no state OAuth.",
    });
    return null;
  }

  const selectVariants = ["id, is_primary, created_at", "id, created_at", "id"];
  for (const sel of selectVariants) {
    const hasPrimary = sel.includes("is_primary");
    let q = supabase.from("seller_companies").select(sel).eq("user_id", uid);
    if (hasPrimary) q = q.order("is_primary", { ascending: false });
    if (sel.includes("created_at")) q = q.order("created_at", { ascending: false });
    q = q.limit(1);
    const { data: rows, error } = await q;
    if (error) {
      const shape =
        String(error?.code ?? "") === "42703" ||
        String(error?.message ?? "")
          .toLowerCase()
          .includes("column");
      if (shape) continue;
      console.warn("[ml/callback] seller_company_list_query_error", {
        user_id: uid,
        select: sel,
        error_code: error.code ?? null,
        error_message: error.message ?? null,
      });
      return null;
    }
    const first = Array.isArray(rows) ? rows[0] : null;
    if (first?.id) return String(first.id);
  }

  const { count, error: cntErr } = await supabase
    .from("seller_companies")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid);
  console.warn("[ml/callback] seller_company_resolved", {
    user_id: uid,
    seller_company_id: null,
    reason: "no_seller_company_row",
    seller_companies_count: !cntErr && typeof count === "number" ? count : null,
    count_error: cntErr?.message ?? null,
  });
  return null;
}

function isPostgrestSchemaShapeError(error) {
  const c = String(error?.code ?? "");
  const m = String(error?.message ?? "").toLowerCase();
  return c === "42703" || m.includes("column") || m.includes("does not exist");
}

function isMarketplaceInsertTryNextVariant(error, variantIndex, totalVariants) {
  if (!error) return false;
  const c = String(error.code ?? "");
  if (isPostgrestSchemaShapeError(error)) return true;
  if (c === "23503") return true;
  if (c === "23502" && variantIndex < totalVariants - 1) return true;
  return false;
}

function omitNullKeys(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v != null));
}

export function logMlCallbackSupabaseError(context, err) {
  const e = err && typeof err === "object" ? err : { message: String(err) };
  console.error("[ml/callback] supabase_error", context, {
    message: e.message ?? null,
    code: e.code ?? null,
    details: e.details ?? null,
    hint: e.hint ?? null,
    constraint: e.constraint ?? e?.cause ?? null,
  });
}

/**
 * Erro Supabase ao gravar ml_tokens — log completo sem tokens.
 * @param {Record<string, unknown>} row — contexto (user_id, marketplace, ml_user_id, marketplace_account_id, …)
 * @param {string} stage
 * @param {unknown} err
 */
export function logPersistTokensSupabaseError(row, stage, err) {
  const e = err && typeof err === "object" ? err : { message: String(err) };
  const mac = row?.marketplace_account_id != null ? String(row.marketplace_account_id).trim() : null;
  const mlUid = row?.ml_user_id != null ? String(row.ml_user_id).trim() : null;
  console.error("[ml/callback] persist_tokens_supabase_error", {
    stage: stage ?? "unknown",
    code: /** @type {{ code?: string }} */ (e).code ?? null,
    message:
      /** @type {{ message?: string }} */ (e).message != null
        ? String(/** @type {{ message?: string }} */ (e).message)
        : null,
    details: /** @type {{ details?: string }} */ (e).details ?? null,
    hint: /** @type {{ hint?: string }} */ (e).hint ?? null,
    constraint: /** @type {{ constraint?: string }} */ (e).constraint ?? null,
    user_id: row?.user_id ?? null,
    marketplace: row?.marketplace ?? null,
    ml_user_id: mlUid,
    marketplace_account_id: mac,
    external_seller_id: row?.external_seller_id != null ? String(row.external_seller_id) : mlUid,
  });
}

function summarizeMlTokensRowForLog(row) {
  if (!row || typeof row !== "object") return {};
  const at = row.access_token;
  const rt = row.refresh_token;
  const mac = row.marketplace_account_id != null ? String(row.marketplace_account_id).trim() : "";
  return {
    user_id: row.user_id,
    marketplace: row.marketplace,
    ml_user_id: row.ml_user_id,
    marketplace_account_id_preview: mac ? `${mac.slice(0, 8)}…` : null,
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
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function enrichMarketplaceAccountRow(supabase, accountId, nick, tokenExpiresAt, siteId, rawMeJson) {
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
    if (!error) break;
    if (!isPostgrestSchemaShapeError(error)) {
      logMlCallbackSupabaseError("marketplace_account_enrich", error);
      return;
    }
  }

  const optionalPatches = [
    { connection_health: "connected", updated_at: nowIso },
    siteId ? { site_id: siteId, updated_at: nowIso } : null,
    rawMeJson != null ? { raw_ml_me: rawMeJson, updated_at: nowIso } : null,
  ].filter(Boolean);
  for (const patch of optionalPatches) {
    const clean = Object.fromEntries(
      Object.entries(/** @type {Record<string, unknown>} */ (patch)).filter(([, v]) => v != null && v !== "")
    );
    if (Object.keys(clean).length === 0) continue;
    const { error } = await supabase.from("marketplace_accounts").update(clean).eq("id", accountId);
    if (!error) continue;
    if (!isPostgrestSchemaShapeError(error)) {
      logMlCallbackSupabaseError("marketplace_account_enrich_optional", error);
    }
  }
}

/**
 * Upsert idempotente: (user_id + marketplace + external_seller_id).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function upsertMercadoLivreMarketplaceAccount(supabase, ctx) {
  const {
    userId,
    marketplace,
    externalSellerId,
    sellerCompanyIdCandidate,
    mlNickname,
    tokenExpiresAt,
    siteId,
    rawMeJson,
    /** Quando true (OAuth com seller_company_id no state), prioriza o CNPJ recebido sobre o já gravado na conta. */
    preferExplicitSellerCompany = false,
  } = ctx;
  const ext = String(externalSellerId || "").trim();
  const nowIso = new Date().toISOString();

  console.info("[ml/callback] marketplace_account_upsert_key", {
    user_id: userId,
    marketplace,
    external_seller_id: ext,
    seller_company_id: sellerCompanyIdCandidate ?? null,
  });
  const nick =
    mlNickname != null && String(mlNickname).trim() !== "" ? String(mlNickname).trim() : null;

  /* Sem .order(updated_at): schemas antigos DEV podem não ter a coluna — quebrava o select inteiro. */
  const { data: existingRows, error: selErr } = await supabase
    .from("marketplace_accounts")
    .select("id, seller_company_id")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("external_seller_id", ext)
    .limit(5);

  if (selErr) {
    logMlCallbackSupabaseError("marketplace_account_select", selErr);
    return { ok: false, error: selErr, accountId: null };
  }

  const existing = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;
  if (Array.isArray(existingRows) && existingRows.length > 1) {
    console.warn("[ml/callback] marketplace_account_select_duplicate_rows", {
      user_id: userId,
      marketplace,
      external_seller_id: ext,
      row_count: existingRows.length,
      using_id: existing?.id ?? null,
    });
  }

  const mergeSellerCompany = (prevRow, incomingResolved, preferIncoming) => {
    const prev =
      prevRow?.seller_company_id != null && String(prevRow.seller_company_id).trim() !== ""
        ? String(prevRow.seller_company_id).trim()
        : null;
    const inc =
      incomingResolved != null && String(incomingResolved).trim() !== ""
        ? String(incomingResolved).trim()
        : null;
    if (preferIncoming && inc) return inc;
    if (prev) return prev;
    return inc;
  };

  if (existing?.id) {
    const prevCo =
      existing.seller_company_id != null && String(existing.seller_company_id).trim() !== ""
        ? String(existing.seller_company_id).trim()
        : "";
    const candCo =
      sellerCompanyIdCandidate != null && String(sellerCompanyIdCandidate).trim() !== ""
        ? String(sellerCompanyIdCandidate).trim()
        : "";
    if (prevCo && candCo && prevCo !== candCo) {
      console.warn("[ml/callback] marketplace_account_seller_company_conflict", {
        code: "ml_seller_wrong_company",
        marketplace_account_id: existing.id,
        existing_seller_company_id: prevCo,
        candidate_seller_company_id: candCo,
      });
      return {
        ok: false,
        error: {
          code: "ml_seller_wrong_company",
          message:
            "Essa conta Mercado Livre já está vinculada a outra empresa no Suse7. Verifique se você entrou na conta correta do Mercado Livre.",
        },
        accountId: null,
      };
    }

    const sellerCo = mergeSellerCompany(existing, sellerCompanyIdCandidate, preferExplicitSellerCompany);
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
      logMlCallbackSupabaseError("marketplace_account_update", upErr);
      return { ok: false, error: upErr, accountId: null };
    }
    await enrichMarketplaceAccountRow(supabase, String(existing.id), nick, tokenExpiresAt, siteId, rawMeJson);
    console.info("[ml/callback] marketplace_account_updated", {
      marketplace_account_id: existing.id,
      user_id: userId,
      external_seller_id: ext,
      seller_company_id: sellerCo || (existing.seller_company_id != null ? String(existing.seller_company_id) : null),
    });
    console.info("[ml/callback] marketplace_account_upsert_ok", {
      via: "update",
      marketplace_account_id: existing.id,
      user_id: userId,
      external_seller_id: ext,
      status: "active",
    });
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
      await enrichMarketplaceAccountRow(supabase, String(inserted.id), nick, tokenExpiresAt, siteId, rawMeJson);
      console.info("[ml/callback] marketplace_account_created", {
        marketplace_account_id: inserted.id,
        user_id: userId,
        external_seller_id: ext,
        seller_company_id: sellerCompanyIdCandidate ?? null,
        insert_variant: vi,
      });
      console.info("[ml/callback] marketplace_account_upsert_ok", {
        via: "insert",
        marketplace_account_id: inserted.id,
        user_id: userId,
        external_seller_id: ext,
        insert_variant: vi,
        status: "active",
      });
      return { ok: true, accountId: String(inserted.id), created: true };
    }

    lastInsErr = insErr;
    if (insErr && String(insErr.code) === "23505") {
      const { data: dupRows, error: dupErr } = await supabase
        .from("marketplace_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .eq("external_seller_id", ext)
        .limit(1);
      const dupRow = Array.isArray(dupRows) ? dupRows[0] : null;
      if (!dupErr && dupRow?.id) {
        console.warn("[ml/callback] marketplace_account_insert_unique_race_recover", {
          variant: vi,
          marketplace_account_id: dupRow.id,
        });
        await enrichMarketplaceAccountRow(supabase, String(dupRow.id), nick, tokenExpiresAt, siteId, rawMeJson);
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
      logMlCallbackSupabaseError("marketplace_account_insert", insErr);
      return { ok: false, error: insErr, accountId: null };
    }
  }

  if (lastInsErr) {
    logMlCallbackSupabaseError("marketplace_account_insert_all_variants", lastInsErr);
    return { ok: false, error: lastInsErr, accountId: null };
  }
  return { ok: false, error: new Error("marketplace_account_insert_no_id"), accountId: null };
}

/**
 * Ajusta payload de ml_tokens quando PostgREST reclama de coluna inexistente / shape.
 * @param {Record<string, unknown>} payload
 * @param {{ message?: string; code?: string; details?: string; hint?: string } | null | undefined} err
 * @returns {Record<string, unknown> | null}
 */
function adaptMlTokensPayloadToSchemaError(payload, err) {
  const msg = String(err?.message ?? "").toLowerCase();
  const next = { ...payload };
  const colMissing =
    msg.includes("does not exist") || msg.includes("undefined column") || msg.includes("42703");

  if (next.expires_at != null && msg.includes("expires_at") && colMissing) {
    const v = next.expires_at;
    delete next.expires_at;
    next.token_expires_at = v;
    return omitNullKeys(next);
  }
  if (next.token_expires_at != null && msg.includes("token_expires_at") && colMissing) {
    const v = next.token_expires_at;
    delete next.token_expires_at;
    next.expires_at = v;
    return omitNullKeys(next);
  }

  const dropCols = [
    "expires_in",
    "scope",
    "token_type",
    "ml_nickname",
    "marketplace_account_id",
    "seller_company_id",
    "updated_at",
    "expires_at",
    "token_expires_at",
  ];
  for (const col of dropCols) {
    if (next[col] == null) continue;
    if (msg.includes(col)) {
      delete next[col];
      return omitNullKeys(next);
    }
  }
  return null;
}

/**
 * Pós-gravação: confirma linha única alinhada (evita falso OK com UNIQUE legado sobrescrevendo outra conta).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function verifyMlTokenRowAfterPersist(supabase, userId, marketplace, mlUid, expectedMarketplaceAccountId) {
  const uid = String(userId || "").trim();
  const mp = String(marketplace || "").trim();
  const ml = String(mlUid || "").trim();
  const expMac = expectedMarketplaceAccountId != null ? String(expectedMarketplaceAccountId).trim() : "";
  if (!uid || !mp || !ml) {
    return { ok: false, error: { code: "verify_bad_input", message: "verifyMlTokenRowAfterPersist: parâmetros ausentes" } };
  }

  let sel = await supabase
    .from("ml_tokens")
    .select("id, ml_user_id, marketplace_account_id")
    .eq("user_id", uid)
    .eq("marketplace", mp)
    .eq("ml_user_id", ml)
    .order("updated_at", { ascending: false })
    .limit(5);

  if (sel.error && isPostgrestSchemaShapeError(sel.error)) {
    sel = await supabase
      .from("ml_tokens")
      .select("id, ml_user_id")
      .eq("user_id", uid)
      .eq("marketplace", mp)
      .eq("ml_user_id", ml)
      .order("updated_at", { ascending: false })
      .limit(5);
  }

  if (sel.error || !Array.isArray(sel.data)) {
    return {
      ok: false,
      error: {
        code: "verify_select_failed",
        message: sel.error?.message ?? "Falha ao verificar ml_tokens após persist",
      },
    };
  }
  const rows = sel.data;
  if (rows.length === 0) {
    return { ok: false, error: { code: "verify_no_token_row", message: "Nenhuma linha ml_tokens após persist" } };
  }
  if (rows.length > 1) {
    console.error("[ml/callback] persist_ml_tokens_verify_multiple_rows_same_ml_user", {
      user_id: uid,
      marketplace: mp,
      ml_user_id: ml,
      row_count: rows.length,
    });
    return {
      ok: false,
      error: {
        code: "verify_multiple_rows",
        message: "Várias linhas ml_tokens para o mesmo user_id+marketplace+ml_user_id",
      },
    };
  }
  const r = rows[0];
  const tokMl = r.ml_user_id != null ? String(r.ml_user_id).trim() : "";
  if (tokMl !== ml) {
    return { ok: false, error: { code: "verify_ml_user_mismatch", message: "ml_user_id divergente pós-persist" } };
  }
  if (expMac && r && "marketplace_account_id" in r) {
    const rowMac =
      r.marketplace_account_id != null && String(r.marketplace_account_id).trim() !== ""
        ? String(r.marketplace_account_id).trim()
        : "";
    if (rowMac && rowMac !== expMac) {
      return {
        ok: false,
        error: {
          code: "verify_marketplace_account_id_mismatch",
          message: "marketplace_account_id no token diverge da conta OAuth",
        },
      };
    }
  }
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function persistMlTokens(supabase, row) {
  const logSummary = summarizeMlTokensRowForLog(row);
  const rowForLog = {
    user_id: row.user_id,
    marketplace: row.marketplace,
    ml_user_id: row.ml_user_id,
    marketplace_account_id: row.marketplace_account_id,
    external_seller_id: row.external_seller_id ?? row.ml_user_id,
  };

  const persistedMarketplaceAccountId =
    row.marketplace_account_id != null && String(row.marketplace_account_id).trim() !== ""
      ? String(row.marketplace_account_id).trim()
      : null;

  const mlUid =
    row.ml_user_id != null && String(row.ml_user_id).trim() !== "" ? String(row.ml_user_id).trim() : "";
  if (!mlUid) {
    const err = { code: "ml_user_id_required", message: "ml_user_id obrigatório para persistir ml_tokens" };
    logPersistTokensSupabaseError(rowForLog, "persist_tokens_missing_ml_user_id", err);
    return { ok: false, error: err, marketplace_account_id: persistedMarketplaceAccountId };
  }

  /** @type {Record<string, unknown>} */
  let persistPayload = omitNullKeys({ ...row });
  delete persistPayload.external_seller_id;
  if (row.seller_company_id != null && String(row.seller_company_id).trim() !== "") {
    persistPayload.seller_company_id = String(row.seller_company_id).trim();
  }

  const marketplaceAccountId =
    row.marketplace_account_id != null && String(row.marketplace_account_id).trim() !== ""
      ? String(row.marketplace_account_id).trim()
      : "";
  if (marketplaceAccountId) {
    const { data: acc, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select("id, user_id, marketplace, external_seller_id")
      .eq("id", marketplaceAccountId)
      .eq("user_id", persistPayload.user_id)
      .eq("marketplace", persistPayload.marketplace)
      .maybeSingle();
    if (accErr || !acc?.id) {
      const err = {
        code: "marketplace_account_not_found_for_token",
        message: accErr?.message ?? "marketplace_account_id inválido para persistência de token",
        details: accErr?.details ?? null,
        hint: accErr?.hint ?? null,
      };
      logPersistTokensSupabaseError(rowForLog, "persist_tokens_account_lookup_failed", accErr || err);
      return { ok: false, error: err, marketplace_account_id: persistedMarketplaceAccountId };
    }
    const accExt =
      acc.external_seller_id != null && String(acc.external_seller_id).trim() !== ""
        ? String(acc.external_seller_id).trim()
        : "";
    if (!accExt || accExt !== mlUid) {
      const err = {
        code: "token_account_mismatch",
        message: "ml_user_id não corresponde ao external_seller_id da marketplace_account",
      };
      logPersistTokensSupabaseError(rowForLog, "persist_tokens_account_alignment_failed", {
        ...err,
        marketplace_account_external_seller_id: accExt || null,
      });
      return { ok: false, error: err, marketplace_account_id: persistedMarketplaceAccountId };
    }
  }

  console.info("[ml/callback] persist_ml_tokens_start", {
    strategy: "upsert",
    onConflict: "user_id,marketplace,ml_user_id",
    payload_summary: logSummary,
  });

  const finalizePersistOk = async () => {
    const v = await verifyMlTokenRowAfterPersist(
      supabase,
      persistPayload.user_id,
      persistPayload.marketplace,
      mlUid,
      marketplaceAccountId
    );
    if (!v.ok) {
      logPersistTokensSupabaseError(rowForLog, "persist_tokens_post_verify_failed", v.error);
      return { ok: false, error: v.error, marketplace_account_id: persistedMarketplaceAccountId };
    }
    return { ok: true, marketplace_account_id: persistedMarketplaceAccountId };
  };

  const runTripleUpsert = (payload) =>
    supabase
      .from("ml_tokens")
      .upsert(payload, { onConflict: "user_id,marketplace,ml_user_id" })
      .select("id, user_id, marketplace, ml_user_id, updated_at");

  let upsertTriple = await runTripleUpsert(persistPayload);
  for (let adapt = 0; adapt < 14 && upsertTriple.error; adapt++) {
    const adapted = adaptMlTokensPayloadToSchemaError(persistPayload, upsertTriple.error);
    if (!adapted) break;
    console.info("[ml/callback] persist_ml_tokens_schema_retry", {
      attempt: adapt + 1,
      user_id: persistPayload.user_id,
      marketplace: persistPayload.marketplace,
      ml_user_id: mlUid,
    });
    persistPayload = adapted;
    upsertTriple = await runTripleUpsert(persistPayload);
  }

  if (!upsertTriple.error) {
    console.info("[ml/callback] token_saved_ok", {
      via: "upsert_user_marketplace_ml_user",
      user_id: persistPayload.user_id,
      marketplace: persistPayload.marketplace,
      ml_user_id: mlUid,
      rows_returned: upsertTriple.data?.length ?? 0,
    });
    return finalizePersistOk();
  }

  const tripleMsg = String(upsertTriple.error?.message ?? "").toLowerCase();
  const tripleCode = String(upsertTriple.error?.code ?? "");
  const maybeMissingTripleUnique =
    tripleCode === "42P10" ||
    tripleCode === "42703" ||
    tripleMsg.includes("no unique") ||
    (tripleMsg.includes("unique constraint") && tripleMsg.includes("ml_user_id"));

  if (maybeMissingTripleUnique) {
    console.warn("[ml/callback] persist_ml_tokens_legacy_unique_fallback", {
      user_id: persistPayload.user_id,
      marketplace: persistPayload.marketplace,
      ml_user_id: mlUid,
      message: upsertTriple.error?.message,
      code: upsertTriple.error?.code,
      hint: "Rode scripts/ml_tokens_multi_account_unique.sql no Supabase para índice único (user_id, marketplace, ml_user_id).",
    });
    const err = {
      code: "ml_tokens_multi_account_unique_required",
      message:
        "Estrutura legada detectada em ml_tokens; aplique scripts/ml_tokens_multi_account_unique.sql e remova unique user_id+marketplace.",
    };
    logPersistTokensSupabaseError(rowForLog, "persist_tokens_legacy_unique_blocked", upsertTriple.error || err);
    return { ok: false, error: err, marketplace_account_id: persistedMarketplaceAccountId };
  }

  logPersistTokensSupabaseError(rowForLog, "persist_tokens_upsert_triple_failed", upsertTriple.error);

  const { data: existingTriple, error: selTripleErr } = await supabase
    .from("ml_tokens")
    .select("id")
    .eq("user_id", persistPayload.user_id)
    .eq("marketplace", persistPayload.marketplace)
    .eq("ml_user_id", mlUid)
    .maybeSingle();

  if (selTripleErr) {
    logPersistTokensSupabaseError(rowForLog, "persist_tokens_select_triple_failed", selTripleErr);
    return { ok: false, error: selTripleErr, marketplace_account_id: persistedMarketplaceAccountId };
  }

  if (existingTriple?.id) {
    /** @type {Record<string, unknown>} */
    let patch = omitNullKeys({
      ml_nickname: persistPayload.ml_nickname,
      access_token: persistPayload.access_token,
      refresh_token: persistPayload.refresh_token,
      expires_in: persistPayload.expires_in,
      expires_at: persistPayload.expires_at,
      token_expires_at: persistPayload.token_expires_at,
      scope: persistPayload.scope,
      token_type: persistPayload.token_type,
      updated_at: persistPayload.updated_at,
      marketplace_account_id: persistPayload.marketplace_account_id,
      seller_company_id: persistPayload.seller_company_id,
    });

    let updErr = /** @type {import("@supabase/postgrest-js").PostgrestError | null} */ (null);
    for (let adapt = 0; adapt < 12; adapt++) {
      const { error } = await supabase.from("ml_tokens").update(patch).eq("id", existingTriple.id);
      if (!error) {
        updErr = null;
        break;
      }
      updErr = error;
      const adapted = adaptMlTokensPayloadToSchemaError(patch, error);
      if (!adapted) break;
      console.info("[ml/callback] persist_ml_tokens_update_schema_retry", { attempt: adapt + 1, ml_tokens_id: existingTriple.id });
      patch = omitNullKeys(adapted);
    }

    if (updErr) {
      logPersistTokensSupabaseError(rowForLog, "persist_tokens_update_by_id_failed", updErr);
      return { ok: false, error: updErr, marketplace_account_id: persistedMarketplaceAccountId };
    }
    console.info("[ml/callback] token_saved_ok", {
      via: "update_by_id_ml_user",
      user_id: persistPayload.user_id,
      marketplace: persistPayload.marketplace,
      ml_user_id: mlUid,
      ml_tokens_id: existingTriple.id,
    });
    return finalizePersistOk();
  }

  let insertPayload = omitNullKeys({ ...persistPayload });
  let inserted = null;
  /** @type {import("@supabase/postgrest-js").PostgrestError | null} */
  let insErr = null;
  for (let adapt = 0; adapt < 12; adapt++) {
    const ins = await supabase.from("ml_tokens").insert(insertPayload).select("id, user_id, marketplace, ml_user_id, updated_at");
    if (!ins.error) {
      inserted = ins.data;
      insErr = null;
      break;
    }
    insErr = ins.error;
    const adapted = adaptMlTokensPayloadToSchemaError(insertPayload, ins.error);
    if (!adapted) break;
    console.info("[ml/callback] persist_ml_tokens_insert_schema_retry", { attempt: adapt + 1 });
    insertPayload = omitNullKeys(adapted);
  }

  if (insErr) {
    logPersistTokensSupabaseError(rowForLog, "persist_tokens_insert_failed", insErr);
    return { ok: false, error: insErr, marketplace_account_id: persistedMarketplaceAccountId };
  }

  console.info("[ml/callback] token_saved_ok", {
    via: "insert",
    user_id: persistPayload.user_id,
    marketplace: persistPayload.marketplace,
    ml_user_id: mlUid,
    rows_returned: inserted?.length ?? 0,
  });
  return finalizePersistOk();
}

/**
 * Reconciliação: ml_tokens existe, nenhuma marketplace_accounts — completa cadastro (idempotente).
 * Jobs de sync inicial **não** são enfileirados aqui por padrão (fluxo NASA: só `POST .../start-initial-sync`).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase — service role
 * @param {string} userId
 * @param {{ enqueueInitialSyncJobs?: boolean }} [options] — só com `enqueueInitialSyncJobs: true` enfileira jobs (legado/admin explícito).
 */
export async function reconcileMarketplaceAccountFromMlTokensRow(supabase, userId, options = {}) {
  const uid = String(userId || "").trim();
  const enqueueInitialSyncJobs = options.enqueueInitialSyncJobs === true;
  if (!uid) return { ok: false, reason: "missing_user_id" };

  const { count: tokCount, error: cntTokErr } = await supabase
    .from("ml_tokens")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .eq("marketplace", ML_MARKETPLACE_SLUG);
  if (!cntTokErr && typeof tokCount === "number" && tokCount > 1) {
    console.warn("[ml/callback] reconcile_skipped", {
      user_id: uid,
      reason: "multiple_ml_tokens_ambiguous",
      ml_tokens_count: tokCount,
    });
    return { ok: false, reason: "multiple_ml_tokens_ambiguous" };
  }

  const { data: tokRows, error: tokErr } = await supabase
    .from("ml_tokens")
    .select("user_id, marketplace, access_token, refresh_token, ml_user_id, ml_nickname, expires_at, expires_in")
    .eq("user_id", uid)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (tokErr || !Array.isArray(tokRows) || !tokRows[0]?.access_token) {
    console.info("[ml/callback] reconcile_skipped", { user_id: uid, reason: "no_ml_tokens_row" });
    return { ok: false, reason: "no_ml_tokens_row" };
  }

  const tok = tokRows[0];
  const { data: accProbe, error: cntErr } = await supabase
    .from("marketplace_accounts")
    .select("id")
    .eq("user_id", uid)
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .limit(1);

  if (!cntErr && Array.isArray(accProbe) && accProbe.length > 0) {
    return { ok: false, reason: "marketplace_account_already_exists" };
  }

  console.info("[ml/callback] reconcile_start", { user_id: uid });

  let meData;
  try {
    meData = await fetchMercadoLibreUserMe(String(tok.access_token), {});
  } catch (e) {
    console.warn("[ml/callback] reconcile_users_me_failed", {
      user_id: uid,
      error_message: e?.message ? String(e.message) : String(e),
    });
    return { ok: false, reason: "users_me_failed" };
  }

  const externalSellerId =
    meData?.id != null && String(meData.id).trim() !== ""
      ? String(meData.id).trim()
      : tok.ml_user_id != null && String(tok.ml_user_id).trim() !== ""
        ? String(tok.ml_user_id).trim()
        : "";
  if (!externalSellerId) {
    console.warn("[ml/callback] reconcile_failed", { user_id: uid, reason: "no_external_seller_id" });
    return { ok: false, reason: "no_external_seller_id" };
  }

  const mlNickname =
    meData?.nickname != null && String(meData.nickname).trim() !== ""
      ? String(meData.nickname).trim()
      : tok.ml_nickname != null
        ? String(tok.ml_nickname).trim()
        : null;
  const siteId = meData?.site_id != null ? String(meData.site_id) : null;
  const rawMeJson = meData && typeof meData === "object" ? meData : null;

  const tokenExpiresAt =
    tok.expires_at != null && String(tok.expires_at).trim() !== ""
      ? String(tok.expires_at).trim()
      : new Date(Date.now() + 6 * 3600000).toISOString();

  const sellerCompanyId = await resolveSellerCompanyIdForMlCallback(supabase, uid, null);
  if (!sellerCompanyId) {
    console.warn("[ml/callback] reconcile_failed", { user_id: uid, reason: "no_seller_company_id" });
    return { ok: false, reason: "no_seller_company_id" };
  }

  console.info("[ml/callback] marketplace_account_upsert_start", {
    user_id: uid,
    seller_company_id: sellerCompanyId,
    external_seller_id: externalSellerId,
    via: "reconcile",
  });

  const accResult = await upsertMercadoLivreMarketplaceAccount(supabase, {
    userId: uid,
    marketplace: ML_MARKETPLACE_SLUG,
    externalSellerId,
    sellerCompanyIdCandidate: sellerCompanyId,
    mlNickname,
    tokenExpiresAt,
    siteId,
    rawMeJson,
  });

  if (!accResult.ok || !accResult.accountId) {
    const er = accResult.error && typeof accResult.error === "object" ? accResult.error : {};
    console.error("[ml/callback] marketplace_account_upsert_error", {
      user_id: uid,
      via: "reconcile",
      error_code: er.code ?? null,
      error_message: er.message ?? String(accResult.error),
    });
    return { ok: false, reason: "marketplace_account_upsert_failed", error: accResult.error };
  }

  if (enqueueInitialSyncJobs) {
    try {
      const jobRes = await createMlInitialSyncJobsIfAbsent(supabase, {
        userId: uid,
        marketplaceAccountId: accResult.accountId,
        sellerCompanyId,
      });
      console.info("[ml/reconcile] initial_jobs_created", {
        user_id: uid,
        marketplace_account_id: accResult.accountId,
        created: jobRes.created,
        skipped: jobRes.skipped,
        via: "reconcile",
        enqueue_initial_sync_jobs: true,
      });
    } catch (e) {
      console.error("[ml/reconcile] initial_jobs_created_error", {
        user_id: uid,
        marketplace_account_id: accResult.accountId,
        error_message: e?.message ? String(e.message) : String(e),
      });
    }
  } else {
    console.info("[ml/reconcile] initial_sync_jobs_deferred", {
      user_id: uid,
      marketplace_account_id: accResult.accountId,
      seller_company_id: sellerCompanyId,
      enqueue_initial_sync_jobs: false,
      note: "Reconcile não enfileira onda inicial; use POST /api/marketplace/accounts/:id/start-initial-sync. Opt-in: enqueueInitialSyncJobs:true.",
    });
  }

  console.info("[ml/callback] reconcile_ok", {
    user_id: uid,
    marketplace_account_id: accResult.accountId,
    external_seller_id: externalSellerId,
  });

  return { ok: true, accountId: accResult.accountId, external_seller_id: externalSellerId };
}
