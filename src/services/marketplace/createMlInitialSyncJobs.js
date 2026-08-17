// ======================================================================
// Jobs de sync Mercado Livre — onboarding (hot / valor rápido) + backfill histórico.
// Idempotente ao enfileirar onboarding: não duplica onda ativa (pending/running).
// ======================================================================

/** Prioridade worker: maior = mais urgente para UX. */
export const ML_JOB_PRIORITY_HOT = 1000;
export const ML_JOB_PRIORITY_MEDIUM = 500;
export const ML_JOB_PRIORITY_BACKFILL = 100;

/**
 * Pipeline onboarding — só dados recentes/essenciais primeiro (sem histórico completo obrigatório).
 * Ordem = dependência entre etapas.
 */
export const ML_HOT_SYNC_JOB_TYPES_ORDERED = [
  "ml_initial_sales_recent",
  "ml_initial_listings_current",
  "ml_initial_fees",
  "ml_initial_products",
  "ml_initial_customers_recent",
  "ml_enable_webhook_monitoring",
];

/** Alias compatível com código que esperava ML_INITIAL_SYNC_JOB_TYPES_ORDERED. */
export const ML_INITIAL_SYNC_JOB_TYPES_ORDERED = ML_HOT_SYNC_JOB_TYPES_ORDERED;

export const ML_SALES_HOT_TYPES = ["ml_initial_sales_recent", "ml_initial_sales_history"];

export const ML_LISTINGS_TYPES = ["ml_initial_listings_current", "ml_initial_listings"];

export const ML_CUSTOMERS_TYPES = ["ml_initial_customers_recent", "ml_initial_customers"];

export const ML_BACKFILL_JOB_TYPES = [
  "ml_historical_sales_backfill",
  "ml_historical_customers_backfill",
  "ml_sales_enrichment_backfill",
];

/** Tipos que o worker/status deve considerar ao montar mapa de pré-requisitos e pools. */
export const ML_ALL_ACCOUNT_SYNC_JOB_TYPES = [
  ...ML_HOT_SYNC_JOB_TYPES_ORDERED,
  ...ML_BACKFILL_JOB_TYPES,
  "ml_initial_sales_history",
  "ml_initial_listings",
  "ml_initial_customers",
];

/** Impede segunda “onda” de onboarding enquanto hot OU legado equivalente ainda está ativo. */
export const ML_ONBOARDING_WAVE_GUARD_TYPES = [
  ...ML_HOT_SYNC_JOB_TYPES_ORDERED,
  "ml_initial_sales_history",
  "ml_initial_listings",
  "ml_initial_customers",
];

/** Reset agressivo (POST force): onboarding + legados equivalentes + jobs de backfill. */
export const ML_FORCE_RESET_JOB_TYPES = [
  ...new Set([...ML_ONBOARDING_WAVE_GUARD_TYPES, ...ML_BACKFILL_JOB_TYPES]),
];

const DAY_MS = 86400000;

export function resolveMlInitialRecentDays() {
  return Math.min(
    3650,
    Math.max(1, parseInt(process.env.ML_INITIAL_RECENT_DAYS || "90", 10) || 90)
  );
}

/**
 * Janelas temporais para backfill de vendas (após hot sync recente).
 * Cobre só o que a API costuma expor (~12 meses) em fatias curtas (timeout / rate limit).
 * @param {number} recentDays âncora ML_INITIAL_RECENT_DAYS (hot = últimos `recentDays`).
 */
export function buildHistoricalSalesBackfillWindows(recentDays) {
  const iso = (ts) => new Date(ts).toISOString();
  const now = Date.now();
  const hotCutoff = now - recentDays * DAY_MS;
  const maxMonths = Math.min(
    24,
    Math.max(1, parseInt(process.env.ML_HISTORY_BACKFILL_MONTHS || "12", 10) || 12)
  );
  const windowDays = Math.min(
    45,
    Math.max(7, parseInt(process.env.ML_HISTORY_BACKFILL_WINDOW_DAYS || "14", 10) || 14)
  );

  /** @type {{ date_from: string; date_to: string; window_index: number; label: string }[]} */
  const windows = [];
  const maxLookbackMs = maxMonths * 30 * DAY_MS;
  const oldestTs = hotCutoff - maxLookbackMs;
  const historical_period_start = iso(oldestTs);
  const historical_period_end = iso(hotCutoff);

  let rangeTo = hotCutoff;
  let idx = 0;
  while (rangeTo > oldestTs) {
    const nextFromTs = rangeTo - windowDays * DAY_MS;
    const rangeFromTs = Math.max(oldestTs, nextFromTs);
    windows.push({
      date_from: iso(rangeFromTs),
      date_to: iso(rangeTo),
      window_index: idx,
      label: `api_window_${windowDays}d_idx_${idx}`,
    });
    idx += 1;
    rangeTo = rangeFromTs;
    if (rangeTo <= oldestTs) break;
  }

  return {
    windows,
    historical_period_start,
    historical_period_end,
    hot_cutoff_iso: historical_period_end,
    recent_days_anchor: recentDays,
  };
}

/**
 * Enfileira janelas de histórico de vendas (baixa prioridade). Idempotente se já existir algum job deste tipo para a conta.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ userId: string; marketplaceAccountId: string; sellerCompanyId?: string | null; marketplace?: string }} ctx
 */
export async function enqueueHistoricalSalesBackfillJobs(supabase, ctx) {
  const accId = String(ctx.marketplaceAccountId || "").trim();
  const uid = String(ctx.userId || "").trim();
  const marketplace = ctx.marketplace ?? "mercado_livre";
  const sellerCompanyId =
    ctx.sellerCompanyId != null && String(ctx.sellerCompanyId).trim() !== ""
      ? String(ctx.sellerCompanyId).trim()
      : null;

  if (!accId || !uid) {
    console.warn("[ML_HISTORICAL_SALES_BACKFILL_SKIP]", { reason: "missing_ids", accId, uid });
    return { created: 0, skipped: true };
  }

  const { data: existing, error: exErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("id")
    .eq("marketplace_account_id", accId)
    .eq("job_type", "ml_historical_sales_backfill")
    .limit(1);

  if (exErr) {
    console.error("[ML_HISTORICAL_SALES_BACKFILL_EXISTS_CHECK]", { message: exErr.message });
    throw exErr;
  }
  if (existing?.length) {
    console.info("[ML_HISTORICAL_SALES_BACKFILL_SKIP]", { reason: "already_enqueued", marketplace_account_id: accId });
    return { created: 0, skipped: true };
  }

  const recentDays = resolveMlInitialRecentDays();

  const pack = buildHistoricalSalesBackfillWindows(recentDays);
  const windowDefs = pack.windows;
  const nowIso = new Date().toISOString();

  const rows = windowDefs.map((w) => ({
    user_id: uid,
    marketplace,
    marketplace_account_id: accId,
    seller_company_id: sellerCompanyId,
    job_type: "ml_historical_sales_backfill",
    status: "pending",
    metadata: {
      wave: "historical_sales_backfill_v1",
      priority: ML_JOB_PRIORITY_BACKFILL,
      date_from: w.date_from,
      date_to: w.date_to,
      window_index: w.window_index,
      window_label: w.label,
      recent_days_anchor: recentDays,
      historical_period_start: pack.historical_period_start,
      historical_period_end: pack.historical_period_end,
      progress_total_windows: windowDefs.length,
      ml_api_orders_search_note:
        "A busca de pedidos no Mercado Livre cobre janela limitada; importamos todas as páginas disponíveis nesta janela.",
    },
    updated_at: nowIso,
  }));

  const { error: insErr } = await supabase.from("marketplace_account_sync_jobs").insert(rows);
  if (insErr) {
    console.error("[ML_HISTORICAL_SALES_BACKFILL_INSERT]", { message: insErr.message });
    throw insErr;
  }

  console.info("[ML_HISTORICAL_SALES_BACKFILL_ENQUEUED]", {
    marketplace_account_id: accId,
    windows: rows.length,
    recent_days: recentDays,
  });

  return { created: rows.length, skipped: false };
}

/**
 * Enfileira jobs da onda “hot” para **um** marketplace_account_id.
 * Não chamar sem `marketplaceAccountId` + `userId` válidos (retorno skipped silencioso se faltar).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   marketplaceAccountId: string;
 *   sellerCompanyId?: string | null;
 *   marketplace?: string;
 * }} ctx
 * @returns {Promise<{ created: number; skipped: boolean }>}
 */
export async function createMlInitialSyncJobsIfAbsent(supabase, ctx) {
  const marketplace = ctx.marketplace ?? "mercado_livre";
  const accId = String(ctx.marketplaceAccountId || "").trim();
  const uid = String(ctx.userId || "").trim();
  if (!accId || !uid) {
    console.warn("[ML_INITIAL_SYNC_CREATED]", { skipped: true, reason: "missing_ids", accId, uid });
    return { created: 0, skipped: true };
  }

  const { data: existing, error: exErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("id")
    .eq("marketplace_account_id", accId)
    .in("job_type", ML_ONBOARDING_WAVE_GUARD_TYPES)
    .in("status", ["pending", "running"])
    .limit(1);

  if (exErr) {
    console.error("[ML_INITIAL_SYNC_CREATED]", { ok: false, error: exErr.message });
    throw exErr;
  }

  if (existing?.length) {
    console.info("[ML_INITIAL_SYNC_CREATED]", {
      skipped: true,
      reason: "active_wave_exists",
      marketplace_account_id: accId,
    });
    return { created: 0, skipped: true };
  }

  const sellerCompanyId =
    ctx.sellerCompanyId != null && String(ctx.sellerCompanyId).trim() !== ""
      ? String(ctx.sellerCompanyId).trim()
      : null;

  const rows = ML_HOT_SYNC_JOB_TYPES_ORDERED.map((job_type) => ({
    user_id: uid,
    marketplace,
    marketplace_account_id: accId,
    seller_company_id: sellerCompanyId,
    job_type,
    status: "pending",
    metadata: {
      wave: "oauth_post_connect_hot_v2",
      priority: ML_JOB_PRIORITY_HOT,
      pipeline: "hot_recent_first",
    },
    updated_at: new Date().toISOString(),
  }));

  const { error: insErr } = await supabase.from("marketplace_account_sync_jobs").insert(rows);
  if (insErr) {
    console.error("[ML_INITIAL_SYNC_CREATED]", { ok: false, error: insErr.message });
    throw insErr;
  }

  console.info("[ML_INITIAL_SYNC_CREATED]", {
    marketplace_account_id: accId,
    user_id: uid,
    jobs: rows.length,
    job_types: ML_HOT_SYNC_JOB_TYPES_ORDERED,
    pipeline: "hot_recent_first",
  });

  return { created: rows.length, skipped: false };
}
