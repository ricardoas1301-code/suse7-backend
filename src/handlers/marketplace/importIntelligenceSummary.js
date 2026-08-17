// ======================================================================
// GET /api/marketplace/import-intelligence — resumo multi-conta ML (JWT).
// Dashboard: progresso hot vs histórico sem N chamadas a sync-status.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import {
  ML_ALL_ACCOUNT_SYNC_JOB_TYPES,
  ML_HOT_SYNC_JOB_TYPES_ORDERED,
  ML_SALES_HOT_TYPES,
  resolveMlInitialRecentDays,
} from "../../services/marketplace/createMlInitialSyncJobs.js";
import {
  buildMlAccountSyncChecklist,
  aggregateHistoricalCustomersJobs,
  pickLatestAmong,
} from "../../services/marketplace/mlAccountSyncChecklist.js";

const MARKETPLACE_ACCOUNT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LISTING_JOB_TYPES = ["ml_initial_listings_current", "ml_initial_listings"];

/** ML_HOT_SYNC_JOB_TYPES_ORDERED → chave do checklist (buildMlAccountSyncChecklist). */
const HOT_PIPELINE_STEP_TO_CHECKLIST_KEY = /** @type {Record<string, string>} */ ({
  ml_initial_sales_recent: "sales_recent",
  ml_initial_listings_current: "listings",
  ml_initial_fees: "fees",
  ml_initial_products: "products",
  ml_initial_customers_recent: "customers",
  ml_enable_webhook_monitoring: "monitoring",
});

const HOT_STEP_LABELS = /** @type {Record<string, string>} */ ({
  ml_initial_sales_recent: "Sincronizando vendas recentes",
  ml_initial_sales_history: "Sincronizando vendas recentes",
  ml_initial_listings_current: "Sincronizando anúncios",
  ml_initial_listings: "Sincronizando anúncios",
  ml_initial_fees: "Sincronizando taxas",
  ml_initial_products: "Sincronizando produtos/SKU",
  ml_initial_customers_recent: "Sincronizando clientes",
  ml_initial_customers: "Sincronizando clientes",
  ml_enable_webhook_monitoring: "Ativando monitoramento",
});

/**
 * @param {Record<string, unknown>[]} checklist
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} hotAllDone
 */
function computeHotSyncSnapshot(checklist, rows, hotAllDone) {
  const totalSteps = ML_HOT_SYNC_JOB_TYPES_ORDERED.length;
  let completedSteps = 0;
  for (const jt of ML_HOT_SYNC_JOB_TYPES_ORDERED) {
    const ck = HOT_PIPELINE_STEP_TO_CHECKLIST_KEY[jt];
    const row = checklist.find((c) => String(c.key || "") === ck);
    const st = row ? String(row.status || "").toLowerCase() : "pending";
    if (st === "done") completedSteps += 1;
  }

  /** @type {string | null} */
  let activeJobType = null;
  /** @type {string | null} */
  let currentStepLabel = null;
  if (!hotAllDone) {
    for (const jt of ML_HOT_SYNC_JOB_TYPES_ORDERED) {
      const ck = HOT_PIPELINE_STEP_TO_CHECKLIST_KEY[jt];
      const row = checklist.find((c) => String(c.key || "") === ck);
      const st = row ? String(row.status || "").toLowerCase() : "pending";
      if (st === "done") continue;
      const jtEff = row?.job_type != null ? String(row.job_type) : jt;
      activeJobType = jtEff;
      currentStepLabel = HOT_STEP_LABELS[jtEff] || HOT_STEP_LABELS[jt] || "Sincronizando…";
      break;
    }
  } else {
    currentStepLabel = "Camada rápida concluída";
    activeJobType = null;
    completedSteps = totalSteps;
  }

  const salesJob = pickLatestAmong(rows, [...ML_SALES_HOT_TYPES]);
  const pc = salesJob != null ? Number(salesJob.progress_current) : NaN;
  const pt = salesJob != null ? Number(salesJob.progress_total) : NaN;
  const salesPct =
    Number.isFinite(pc) && Number.isFinite(pt) && pt > 0 ? Math.min(100, Math.round((100 * pc) / pt)) : null;
  const stepsPct = totalSteps > 0 ? Math.round((100 * completedSteps) / totalSteps) : 0;
  let progressPercent = hotAllDone ? 100 : Math.max(salesPct ?? 0, stepsPct);
  if (!hotAllDone && salesPct != null && (salesPct > 0 || String(salesJob?.status || "").toLowerCase() === "running")) {
    progressPercent = Math.max(progressPercent, salesPct);
  }

  const hotTypes = new Set([
    ...ML_HOT_SYNC_JOB_TYPES_ORDERED,
    ...ML_SALES_HOT_TYPES,
    "ml_initial_listings",
    "ml_initial_customers",
  ]);
  const hotRows = rows.filter((r) => hotTypes.has(String(r.job_type || "")));
  const lastActivityAt = maxUpdatedAt(hotRows);
  const anyHotJobRunning = hotRows.some((r) => String(r.status || "").toLowerCase() === "running");

  let status = "pending";
  if (hotAllDone) status = "completed";
  else if (
    checklist.some((c) => String(c.sync_layer || "") === "hot" && String(c.status || "").toLowerCase() === "error")
  )
    status = "error";
  else if (
    checklist.some((c) => String(c.sync_layer || "") === "hot" && String(c.status || "").toLowerCase() === "running")
  )
    status = "running";
  else if (anyHotJobRunning) status = "running";

  return {
    status,
    progress_current: Number.isFinite(pc) ? pc : null,
    progress_total: Number.isFinite(pt) ? pt : null,
    progress_percent: Number.isFinite(progressPercent) ? progressPercent : stepsPct,
    current_step_label: currentStepLabel,
    completed_steps: completedSteps,
    total_steps: totalSteps,
    active_job_type: activeJobType,
    last_activity_at: lastActivityAt,
  };
}

/**
 * @param {boolean} hotAllDone
 * @param {Record<string, unknown> | null} histSales
 * @param {Record<string, unknown> | null} histCustomers
 */
function computeHistoricalSyncSnapshot(hotAllDone, histSales, histCustomers) {
  const hsSt = histSales ? String(histSales.status || "").toLowerCase() : "";
  const hcSt = histCustomers ? String(histCustomers.status || "").toLowerCase() : "";
  const hasHistSalesJobs = Boolean(histSales && (Number(histSales.windows_total) || 0) > 0);
  const hasHistCustomersJobs = Boolean(histCustomers && (Number(histCustomers.windows_total) || 0) > 0);

  if (!hotAllDone) {
    return {
      status: "queued",
      progress_percent: 0,
      message_pt: "O histórico completo será iniciado automaticamente após os dados principais.",
    };
  }
  if (!hasHistSalesJobs && !hasHistCustomersJobs) {
    return {
      status: "queued",
      progress_percent: 0,
      message_pt: "O histórico completo será enfileirado automaticamente após os dados principais.",
    };
  }
  if (hsSt === "running" || hsSt === "pending" || hcSt === "running" || hcSt === "pending") {
    const pcS = Number(histSales?.progress_current);
    const ptS = Number(histSales?.progress_total);
    const pctS =
      histSales && Number.isFinite(ptS) && ptS > 0 && Number.isFinite(pcS)
        ? Math.min(100, Math.round((100 * pcS) / ptS))
        : null;
    const pcC = Number(histCustomers?.progress_current);
    const ptC = Number(histCustomers?.progress_total);
    const pctC =
      histCustomers && Number.isFinite(ptC) && ptC > 0 && Number.isFinite(pcC)
        ? Math.min(100, Math.round((100 * pcC) / ptC))
        : null;
    const pct = Math.max(pctS ?? 0, pctC ?? 0, hsSt === "pending" || hcSt === "pending" ? 0 : 0);
    return {
      status: "running",
      progress_percent: pct,
      message_pt: "O Suse7 está importando seu histórico completo em segundo plano.",
    };
  }
  if (hsSt === "error" || hcSt === "error") {
    return {
      status: "error",
      progress_percent: 0,
      message_pt: "Parte do histórico precisou de atenção; os dados principais já estão disponíveis.",
    };
  }
  return {
    status: "completed",
    progress_percent: 100,
    message_pt: "Histórico completo sincronizado.",
  };
}

/**
 * @param {number | null | undefined} pct
 */
function qualitativeForecastPt(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) {
    return "O servidor continua processando em segundo plano — sem necessidade de manter o app aberto.";
  }
  if (p < 20) {
    return "Fase inicial do histórico: volumes grandes podem levar várias horas. Ritmo estável.";
  }
  if (p < 55) {
    return "Importação em ritmo constante; janelas antigas estão sendo organizadas automaticamente.";
  }
  if (p < 92) {
    return "Boa parte do histórico já está no Suse7 — reta final em andamento.";
  }
  return "Quase concluído — últimos blocos de histórico sendo finalizados.";
}

/**
 * @param {Record<string, unknown>[]} rows
 */
function maxUpdatedAt(rows) {
  let best = 0;
  for (const r of rows) {
    const t = Date.parse(String(r.updated_at ?? r.created_at ?? ""));
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best > 0 ? new Date(best).toISOString() : null;
}

/**
 * @param {Record<string, unknown>[]} rows
 */
function runningBackfillJobTypes(rows) {
  const set = new Set();
  for (const r of rows) {
    if (String(r.status || "").toLowerCase() !== "running") continue;
    const jt = String(r.job_type || "");
    if (jt.includes("historical") || jt.includes("backfill") || jt === "ml_sales_enrichment_backfill") {
      set.add(jt);
    }
  }
  return [...set];
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleMarketplaceImportIntelligenceSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const mp = req.query?.marketplace != null ? String(req.query.marketplace).trim().toLowerCase() : "";
  const marketplace = mp || ML_MARKETPLACE_SLUG;
  const filterAccountIdRaw =
    req.query?.marketplace_account_id != null ? String(req.query.marketplace_account_id).trim() : "";
  const filterAccountId =
    filterAccountIdRaw && MARKETPLACE_ACCOUNT_UUID_RE.test(filterAccountIdRaw) ? filterAccountIdRaw : "";

  try {
    const { data: accounts, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select("id,status,marketplace,ml_nickname,account_alias,external_seller_id,updated_at")
      .eq("user_id", user.id)
      .eq("marketplace", marketplace)
      .neq("status", "removed")
      .order("created_at", { ascending: false });

    if (accErr) {
      console.error("[marketplace/import-intelligence] accounts", accErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar contas." });
    }

    let accRows = Array.isArray(accounts) ? accounts : [];
    if (filterAccountId) {
      accRows = accRows.filter((a) => String(a.id) === filterAccountId);
    }
    if (accRows.length === 0) {
      return res.status(200).json({
        ok: true,
        marketplace,
        ml_initial_recent_days: resolveMlInitialRecentDays(),
        accounts: [],
        any_engaged: false,
        any_historical_backfill_active: false,
        any_hot_incomplete: false,
      });
    }

    const ids = accRows.map((a) => String(a.id)).filter(Boolean);
    const { data: jobRows, error: jobErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .select("*")
      .in("marketplace_account_id", ids)
      .in("job_type", ML_ALL_ACCOUNT_SYNC_JOB_TYPES)
      .order("created_at", { ascending: false })
      .limit(4000);

    if (jobErr) {
      console.error("[marketplace/import-intelligence] jobs", jobErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar jobs." });
    }

    const allJobs = Array.isArray(jobRows) ? jobRows : [];
    /** @type {Map<string, Record<string, unknown>[]>} */
    const byAccount = new Map();
    for (const j of allJobs) {
      const aid = String(j.marketplace_account_id || "");
      if (!aid) continue;
      if (!byAccount.has(aid)) byAccount.set(aid, []);
      byAccount.get(aid).push(j);
    }

    /** @type {Record<string, unknown>[]} */
    const summaries = [];
    let anyEngaged = false;
    let anyHistorical = false;
    let anyHotIncomplete = false;

    for (const acc of accRows) {
      const aid = String(acc.id);
      const rows = byAccount.get(aid) ?? [];
      if (rows.length > 0) anyEngaged = true;

      const { checklist, historicalSalesAgg, hotAllDone, hasEngagedInitialSync } = buildMlAccountSyncChecklist(
        acc,
        rows
      );

      const gateStatuses = checklist
        .filter((x) => String(x.sync_layer || "") !== "historical")
        .map((x) => String(x.status || ""));
      const anyError = gateStatuses.some((s) => s === "error");
      const allHotDone = gateStatuses.length > 0 && gateStatuses.every((s) => s === "done");
      let overall = "idle";
      if (!hasEngagedInitialSync) overall = "awaiting_start";
      else if (gateStatuses.length === 0) overall = "no_jobs";
      else if (anyError) overall = "error";
      else if (allHotDone) overall = "done";
      else overall = "running";

      if (overall === "running") anyHotIncomplete = true;

      const histSales = historicalSalesAgg;
      const histCustomers = aggregateHistoricalCustomersJobs(rows);
      const listingJob = pickLatestAmong(rows, LISTING_JOB_TYPES);

      const hsSt = histSales ? String(histSales.status || "").toLowerCase() : "";
      const hcSt = histCustomers ? String(histCustomers.status || "").toLowerCase() : "";
      const historicalBackfillActive =
        hsSt === "pending" ||
        hsSt === "running" ||
        hcSt === "pending" ||
        hcSt === "running";

      if (historicalBackfillActive) anyHistorical = true;

      const pc = Number(histSales?.progress_current);
      const pt = Number(histSales?.progress_total);
      let backgroundPercent = null;
      if (histSales && Number.isFinite(pt) && pt > 0 && Number.isFinite(pc)) {
        backgroundPercent = Math.min(100, Math.round((100 * pc) / pt));
      } else if (histSales && hsSt === "done") {
        backgroundPercent = 100;
      }

      const displayName =
        (acc.ml_nickname != null && String(acc.ml_nickname).trim()) ||
        (acc.account_alias != null && String(acc.account_alias).trim()) ||
        (acc.external_seller_id != null ? `Conta ${String(acc.external_seller_id).slice(0, 8)}` : "Mercado Livre");

      const hotSync = computeHotSyncSnapshot(checklist, rows, hotAllDone);
      const historicalSync = computeHistoricalSyncSnapshot(hotAllDone, histSales, histCustomers);
      const primaryProgressPercent = hotAllDone ? historicalSync.progress_percent : hotSync.progress_percent;

      let statusHeadline = "Aguardando sincronização";
      if (overall === "awaiting_start") {
        statusHeadline = "Pronto para importar dados recentes";
      } else if (overall === "running") {
        statusHeadline = hotSync.current_step_label || "Preparando dados principais…";
      } else if (overall === "done" && historicalBackfillActive) {
        statusHeadline = "Importando histórico completo…";
      } else if (overall === "done") {
        statusHeadline = histCustomers && String(histCustomers.status || "").toLowerCase() !== "done"
          ? "Finalizando histórico de clientes…"
          : "Histórico em dia";
      } else if (overall === "error") {
        statusHeadline = "Atenção na integração";
      }

      const forecastMessagePt = hotAllDone
        ? qualitativeForecastPt(backgroundPercent)
        : "Estamos preparando seus dados principais para uso imediato. Você já pode continuar usando o app.";

      summaries.push({
        marketplace_account_id: aid,
        account_id: aid,
        account_label: displayName,
        display_name: displayName,
        overall,
        hot_sync_complete: hotAllDone,
        historical_backfill_active: historicalBackfillActive,
        hot_sync: hotSync,
        historical_sync: historicalSync,
        primary_progress_percent: primaryProgressPercent,
        historical_sales_sync: histSales,
        historical_customers_sync: histCustomers,
        listings: listingJob
          ? {
              status: String(listingJob.status || ""),
              progress_current: listingJob.progress_current ?? null,
              progress_total: listingJob.progress_total ?? null,
            }
          : null,
        background_percent: backgroundPercent,
        forecast_message_pt: forecastMessagePt,
        last_job_activity_at: maxUpdatedAt(rows),
        running_background_job_types: runningBackfillJobTypes(rows),
        checklist_slice: {
          hot_done: hotAllDone,
          historical_sales_windows_done: histSales?.windows_done ?? 0,
          historical_sales_windows_total: histSales?.windows_total ?? 0,
        },
        status_headline: statusHeadline,
      });
    }

    return res.status(200).json({
      ok: true,
      marketplace,
      ml_initial_recent_days: resolveMlInitialRecentDays(),
      accounts: summaries,
      any_engaged: anyEngaged,
      any_historical_backfill_active: anyHistorical,
      any_hot_incomplete: anyHotIncomplete,
    });
  } catch (e) {
    console.error("[marketplace/import-intelligence]", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
