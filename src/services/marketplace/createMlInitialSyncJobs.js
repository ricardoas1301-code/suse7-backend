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



  const pack = buildHistoricalSalesBackfillWindows();

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

      progress_total_windows: windowDefs.length,

      ml_api_orders_search_note:

        "Importamos exatamente a janela de 12 meses calendário; fatias de API não expandem o horizonte comercial.",

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

    calendar_months: pack.calendar_months,

    hot_days: pack.hot_days,

    target_history_start: pack.target_history_start_iso,

    target_history_end: pack.target_history_end_iso,

  });



  return { created: rows.length, skipped: false };

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


