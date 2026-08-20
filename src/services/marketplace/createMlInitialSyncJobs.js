// ======================================================================

// Jobs de sync Mercado Livre — onboarding (masters first) + backfill histórico.

// Idempotente ao enfileirar onboarding: não duplica onda ativa (pending/running).

// DEV.V2.ML-INITIAL-SYNC-ORDER-HISTORY-WINDOW-CLOSE.01E-E

// ======================================================================



import {

  buildHistoricalSalesBackfillWindows,

  resolveMlHotRecentDays,

  resolveMlSalesHistoryWindow,

} from "./mlSalesHistoryWindow.js";



/** Prioridade worker: maior = mais urgente para UX. */

export const ML_JOB_PRIORITY_HOT = 1000;

export const ML_JOB_PRIORITY_MEDIUM = 500;

export const ML_JOB_PRIORITY_BACKFILL = 100;



/**

 * Pipeline onboarding — masters first, vendas hot por último na onda hot.

 * Ordem = dependência entre etapas (01E-E aprovado).

 */

export const ML_HOT_SYNC_JOB_TYPES_ORDERED = [

  "ml_initial_listings_current",

  "ml_initial_fees",

  "ml_initial_products",

  "ml_initial_customers_recent",

  "ml_enable_webhook_monitoring",

  "ml_initial_sales_recent",

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



/** @deprecated use resolveMlHotRecentDays from mlSalesHistoryWindow.js */

export function resolveMlInitialRecentDays() {

  return resolveMlHotRecentDays();

}



export { buildHistoricalSalesBackfillWindows, resolveMlSalesHistoryWindow };



/**
 * Identidade canônica de uma janela histórica ML (escopo: conta + job_type implícito).
 * @param {{ window_index?: unknown; date_from?: unknown; date_to?: unknown }} windowDef
 */
export function buildHistoricalSalesWindowIdentity(windowDef) {
  return {
    window_index: Number(windowDef?.window_index),
    date_from: String(windowDef?.date_from ?? "").trim(),
    date_to: String(windowDef?.date_to ?? "").trim(),
  };
}

/**
 * @param {ReturnType<typeof buildHistoricalSalesWindowIdentity>} identity
 */
export function historicalSalesWindowIdentityKey(identity) {
  return `${identity.window_index}|${identity.date_from}|${identity.date_to}`;
}

/**
 * @param {{ metadata?: Record<string, unknown> | null }} row
 */
export function readHistoricalWindowIdentityFromJobRow(row) {
  const meta = row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
  return buildHistoricalSalesWindowIdentity({
    window_index: meta.window_index,
    date_from: meta.date_from,
    date_to: meta.date_to,
  });
}

/**
 * Ancora cutover na grade existente para convergir janelas temporais idênticas.
 * @param {Record<string, unknown>[]} [existingRows]
 * @param {Date | string | number | undefined} [cutoverOverride]
 */
export function resolveHistoricalBackfillPack(existingRows = [], cutoverOverride) {
  if (cutoverOverride != null) return buildHistoricalSalesBackfillWindows(cutoverOverride);
  for (const row of existingRows) {
    const meta = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const cutover = meta.target_history_end_iso || meta.hot_end_iso || meta.cutover_iso;
    if (cutover) return buildHistoricalSalesBackfillWindows(String(cutover));
  }
  return buildHistoricalSalesBackfillWindows();
}

/**
 * @param {ReturnType<typeof buildHistoricalSalesBackfillWindows>} pack
 * @param {Record<string, unknown>[]} existingRows
 */
export function findMissingHistoricalSalesBackfillWindows(pack, existingRows) {
  const existingKeys = new Set();
  for (const row of existingRows || []) {
    const identity = readHistoricalWindowIdentityFromJobRow(row);
    if (!Number.isFinite(identity.window_index) || identity.window_index < 0) continue;
    if (!identity.date_from || !identity.date_to) continue;
    existingKeys.add(historicalSalesWindowIdentityKey(identity));
  }
  /** @type {typeof pack.windows} */
  const missing = [];
  for (const w of pack.windows) {
    const key = historicalSalesWindowIdentityKey(buildHistoricalSalesWindowIdentity(w));
    if (!existingKeys.has(key)) missing.push(w);
  }
  return missing;
}

/**
 * Monta linhas de insert para janelas faltantes.
 * @param {ReturnType<typeof buildHistoricalSalesBackfillWindows>} pack
 * @param {typeof pack.windows} windowDefs
 * @param {{ userId: string; marketplaceAccountId: string; sellerCompanyId?: string | null; marketplace?: string }} ctx
 */
export function buildHistoricalSalesBackfillJobRows(pack, windowDefs, ctx) {
  const accId = String(ctx.marketplaceAccountId || "").trim();
  const uid = String(ctx.userId || "").trim();
  const marketplace = ctx.marketplace ?? "mercado_livre";
  const sellerCompanyId =
    ctx.sellerCompanyId != null && String(ctx.sellerCompanyId).trim() !== ""
      ? String(ctx.sellerCompanyId).trim()
      : null;
  const nowIso = new Date().toISOString();
  return windowDefs.map((w) => ({
    user_id: uid,
    marketplace,
    marketplace_account_id: accId,
    seller_company_id: sellerCompanyId,
    job_type: "ml_historical_sales_backfill",
    status: "pending",
    metadata: {
      wave: "historical_sales_backfill_v2_calendar",
      priority: ML_JOB_PRIORITY_BACKFILL,
      date_from: w.date_from,
      date_to: w.date_to,
      window_index: w.window_index,
      window_label: w.label,
      boundary_contract: pack.boundary_contract,
      target_history_start_iso: pack.target_history_start_iso,
      target_history_end_iso: pack.target_history_end_iso,
      hot_start_iso: pack.hot_start_iso,
      hot_end_iso: pack.hot_end_iso,
      backfill_start_iso: pack.backfill_start_iso,
      backfill_end_iso: pack.backfill_end_iso,
      calendar_months: pack.calendar_months,
      hot_days: pack.hot_days,
      chunk_days: pack.chunk_days,
      progress_total_windows: pack.windows.length,
      ml_api_orders_search_note:
        "Importamos exatamente a janela de 12 meses calendário; fatias de API não expandem o horizonte comercial.",
    },
    updated_at: nowIso,
  }));
}



/**
 * Reconcilia grade histórica: expected (SSOT) vs existing → cria somente faltantes.
 * Idempotente; retomável após grade parcial ou replay pós-done.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ userId: string; marketplaceAccountId: string; sellerCompanyId?: string | null; marketplace?: string; cutoverIso?: string }} ctx
 */
export async function reconcileHistoricalSalesBackfillJobs(supabase, ctx) {
  const accId = String(ctx.marketplaceAccountId || "").trim();
  const uid = String(ctx.userId || "").trim();
  if (!accId || !uid) {
    console.warn("[ML_HISTORICAL_SALES_BACKFILL_SKIP]", { reason: "missing_ids", accId, uid });
    return { created: 0, skipped: true, expected_total: 0, existing_total: 0, missing_before: 0 };
  }

  const { data: existingRows, error: exErr } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("id, status, metadata")
    .eq("marketplace_account_id", accId)
    .eq("job_type", "ml_historical_sales_backfill");

  if (exErr) {
    console.error("[ML_HISTORICAL_SALES_BACKFILL_EXISTS_CHECK]", { message: exErr.message });
    throw exErr;
  }

  const existing = existingRows ?? [];
  const pack = resolveHistoricalBackfillPack(existing, ctx.cutoverIso);
  const missing = findMissingHistoricalSalesBackfillWindows(pack, existing);

  if (!missing.length) {
    console.info("[ML_HISTORICAL_SALES_BACKFILL_RECONCILE]", {
      marketplace_account_id: accId,
      expected_total: pack.windows.length,
      existing_total: existing.length,
      created: 0,
      reason: "already_converged",
    });
    return {
      created: 0,
      skipped: true,
      expected_total: pack.windows.length,
      existing_total: existing.length,
      missing_before: 0,
    };
  }

  const rows = buildHistoricalSalesBackfillJobRows(pack, missing, ctx);

  let created = 0;
  for (const w of missing) {
    const { data: freshRows, error: freshErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .select("id, status, metadata")
      .eq("marketplace_account_id", accId)
      .eq("job_type", "ml_historical_sales_backfill");
    if (freshErr) throw freshErr;

    const stillMissing = findMissingHistoricalSalesBackfillWindows(pack, freshRows ?? []);
    if (!stillMissing.some((m) => m.window_index === w.window_index)) continue;

    const [row] = buildHistoricalSalesBackfillJobRows(pack, [w], ctx);
    const { error: insErr } = await supabase.from("marketplace_account_sync_jobs").insert([row]);
    if (insErr) {
      if (insErr.code === "23505") continue;
      console.error("[ML_HISTORICAL_SALES_BACKFILL_INSERT]", {
        message: insErr.message,
        window_index: w.window_index,
      });
      throw insErr;
    }
    created += 1;
  }

  if (!created) {
    console.info("[ML_HISTORICAL_SALES_BACKFILL_RECONCILE]", {
      marketplace_account_id: accId,
      expected_total: pack.windows.length,
      existing_total: existing.length,
      created: 0,
      reason: "converged_after_race_or_recheck",
    });
    return {
      created: 0,
      skipped: true,
      expected_total: pack.windows.length,
      existing_total: existing.length,
      missing_before: missing.length,
    };
  }

  console.info("[ML_HISTORICAL_SALES_BACKFILL_ENQUEUED]", {
    marketplace_account_id: accId,
    windows_created: created,
    expected_total: pack.windows.length,
    existing_before: existing.length,
    missing_before: missing.length,
    calendar_months: pack.calendar_months,
    hot_days: pack.hot_days,
    target_history_start: pack.target_history_start_iso,
    target_history_end: pack.target_history_end_iso,
    reconcile: true,
  });

  return {
    created,
    skipped: false,
    expected_total: pack.windows.length,
    existing_total: existing.length,
    missing_before: missing.length,
  };
}



/**
 * Enfileira janelas de histórico de vendas (baixa prioridade).
 * Reconcilia expected vs existing — não usa mais "any exists → skip all".
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ userId: string; marketplaceAccountId: string; sellerCompanyId?: string | null; marketplace?: string }} ctx
 */
export async function enqueueHistoricalSalesBackfillJobs(supabase, ctx) {
  return reconcileHistoricalSalesBackfillJobs(supabase, ctx);
}



/**

 * Enfileira jobs da onda “hot” para **um** marketplace_account_id.

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



  const historyWindow = resolveMlSalesHistoryWindow();



  const rows = ML_HOT_SYNC_JOB_TYPES_ORDERED.map((job_type) => {

    /** @type {Record<string, unknown>} */

    const metadata = {

      wave: "oauth_post_connect_masters_first_v1",

      priority: ML_JOB_PRIORITY_HOT,

      pipeline: "masters_first_then_sales",

      target_history_start_iso: historyWindow.target_history_start_iso,

      target_history_end_iso: historyWindow.target_history_end_iso,

      calendar_months: historyWindow.calendar_months,

    };

    if (job_type === "ml_initial_sales_recent") {

      Object.assign(metadata, {

        sales_history_window: historyWindow,

        date_from: historyWindow.hot_start_iso,

        date_to: historyWindow.hot_end_iso,

        hot_start_iso: historyWindow.hot_start_iso,

        hot_end_iso: historyWindow.hot_end_iso,

        hot_days: historyWindow.hot_days,

        boundary_contract: historyWindow.boundary_contract,

      });

    }

    return {

      user_id: uid,

      marketplace,

      marketplace_account_id: accId,

      seller_company_id: sellerCompanyId,

      job_type,

      status: "pending",

      metadata,

      updated_at: new Date().toISOString(),

    };

  });



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

    pipeline: "masters_first_then_sales",

    target_history_start: historyWindow.target_history_start_iso,

    target_history_end: historyWindow.target_history_end_iso,

  });



  return { created: rows.length, skipped: false };

}


