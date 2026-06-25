// ======================================================================
// GET /api/marketplace/accounts/:id/sync-status — checklist onboarding ML (JWT).
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { ML_MARKETPLACE_SLUG } from "../ml/_helpers/mlMarketplace.js";
import { config } from "../../infra/config.js";
import {
  ML_HOT_SYNC_JOB_TYPES_ORDERED,
  ML_ALL_ACCOUNT_SYNC_JOB_TYPES,
  ML_BACKFILL_JOB_TYPES,
  resolveMlInitialRecentDays,
} from "../../services/marketplace/createMlInitialSyncJobs.js";
import {
  buildMlAccountSyncChecklist,
  aggregateHistoricalCustomersJobs,
} from "../../services/marketplace/mlAccountSyncChecklist.js";
import {
  buildMlHistoricalSalesUxState,
  fetchMlHistoricalCoverageRollupForAccount,
} from "../../services/marketplace/mlHistoricalSalesUx.js";
import {
  buildMlConnectionUiPack,
  fetchMarketplaceAccountsWithActiveMlPipeline,
  fetchMlTokenProbeForMlSeller,
  syncStatusNeedsAttention,
} from "../../services/marketplace/marketplaceAccountConnectionHealth.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_PROGRESS_MS = Math.min(
  24 * 60 * 60 * 1000,
  Math.max(30 * 1000, parseInt(process.env.ML_SYNC_STATUS_STALE_MS || "90000", 10) || 90000)
);
const BACKFILL_JOB_TYPE_SET = new Set(ML_BACKFILL_JOB_TYPES);

const PENDING_QUEUE_WARNING_MS = Math.min(
  24 * 60 * 60 * 1000,
  Math.max(30 * 1000, parseInt(process.env.ML_SYNC_PENDING_QUEUE_WARNING_MS || "120000", 10) || 120000)
);

/** Cooldown entre POSTs de “acordar drain” por conta (evita tempestade se o job endpoint falhar ou o cliente polir 4s). */
const DRAIN_NUDGE_COOLDOWN_MS = Math.min(
  30 * 60 * 1000,
  Math.max(60 * 1000, parseInt(process.env.ML_SYNC_DRAIN_NUDGE_COOLDOWN_MS || "120000", 10) || 120000)
);
/** Log de skip no máximo 1x por janela por conta (não poluir logs). */
const DRAIN_NUDGE_SKIP_LOG_COOLDOWN_MS = 5 * 60 * 1000;
/** @type {Map<string, number>} */
const drainNudgeLastPostAtMs = new Map();
/** @type {Map<string, number>} */
const drainNudgeSkipLogAtMs = new Map();

/** Labels UX estágio inicial ML (ordem = pipeline). */
const INITIAL_PIPELINE_STAGE_LABELS = /** @type {Record<string, string>} */ ({
  ml_initial_sales_recent: "Sincronizando vendas recentes",
  ml_initial_sales_history: "Sincronizando vendas recentes",
  ml_historical_sales_backfill: "Importando histórico de vendas",
  ml_initial_listings_current: "Sincronizando anúncios",
  ml_initial_listings: "Sincronizando anúncios",
  ml_initial_fees: "Sincronizando taxas",
  ml_initial_products: "Sincronizando produtos/SKU",
  ml_initial_customers_recent: "Sincronizando clientes",
  ml_initial_customers: "Sincronizando clientes",
  ml_enable_webhook_monitoring: "Ativando monitoramento",
});

/**
 * @param {{
 *   checklist: Record<string, unknown>[];
 *   overall: string;
 *   historical_sales_aggregate?: Record<string, unknown> | null;
 *   historical_customers_aggregate?: Record<string, unknown> | null;
 *   historical_sales_ux?: Record<string, unknown> | null;
 * }} ctx
 */
function resolveIntegrationStage(ctx) {
  const checklist = ctx.checklist;
  const overall = String(ctx.overall || "");
  /** @type {Record<string, unknown> | null | undefined} */
  const historicalAgg = ctx.historical_sales_aggregate;
  /** @type {Record<string, unknown> | null | undefined} */
  const histCust = ctx.historical_customers_aggregate;
  /** @type {Record<string, unknown> | null | undefined} */
  const histUx = ctx.historical_sales_ux;

  if (overall === "awaiting_start") {
    return {
      code: "awaiting_start",
      label: "Pronto para iniciar",
      detail:
        "Toque em Sincronizar para enfileirar a importação. Depois você pode fechar esta janela — o processamento segue no servidor.",
    };
  }
  if (overall === "idle" || overall === "no_jobs") {
    return { code: overall, label: null, detail: null };
  }
  if (overall === "error") {
    return {
      code: "failed",
      label: "Falhou — tente novamente",
      detail: "Se persistir, reconecte o Mercado Livre ou fale com o suporte.",
    };
  }
  if (overall === "completed_with_errors") {
    return {
      code: "completed_with_warnings",
      label: "Concluído com avisos",
      detail: "Alguns itens podem precisar de revisão; dados principais já foram importados.",
    };
  }
  if (overall === "done") {
    const hs = historicalAgg;
    const hst = hs ? String(hs.status || "").toLowerCase() : "";
    const cst = histCust ? String(histCust.status || "").toLowerCase() : "";
    const histActive =
      hst === "running" || hst === "pending" || cst === "running" || cst === "pending";
    if (histActive) {
      const title =
        typeof histUx?.processing_title === "string" && histUx.processing_title.trim() !== ""
          ? String(histUx.processing_title).trim()
          : "Importando histórico disponível de vendas…";
      const parts = [];
      if (typeof histUx?.processing_period_line === "string" && histUx.processing_period_line.trim() !== "") {
        parts.push(String(histUx.processing_period_line).trim());
      }
      if (typeof histUx?.processing_window_line === "string" && histUx.processing_window_line.trim() !== "") {
        parts.push(String(histUx.processing_window_line).trim());
      }
      const detail = parts.length ? parts.join(" · ") : null;
      return {
        code: "hot_complete_history_background",
        label: "Dados recentes prontos",
        detail: detail || title,
      };
    }
    if (hst === "error" || cst === "error") {
      return {
        code: "completed_hot_historical_warnings",
        label: "Dados recentes prontos",
        detail: "Parte do histórico antigo precisa de nova tentativa; o app já pode ser usado.",
      };
    }
    const c1 =
      typeof histUx?.completion_line_1 === "string" && histUx.completion_line_1.trim() !== ""
        ? String(histUx.completion_line_1).trim()
        : "Histórico disponível importado.";
    const c2 =
      typeof histUx?.completion_line_2 === "string" && histUx.completion_line_2.trim() !== ""
        ? String(histUx.completion_line_2).trim()
        : "Novas vendas e atualizações serão monitoradas automaticamente.";
    return {
      code: "completed",
      label: "Concluído",
      detail: `${c1} ${c2}`,
    };
  }

  if (overall === "running") {
    for (const jt of ML_HOT_SYNC_JOB_TYPES_ORDERED) {
      const row = checklist.find((x) => String(x.job_type || "") === jt);
      if (!row) continue;
      const st = String(row.status || "").toLowerCase();
      if (st === "done") continue;
      const human = INITIAL_PIPELINE_STAGE_LABELS[jt] || jt;
      if (st === "pending") {
        return { code: "queued", label: "Na fila", detail: human };
      }
      if (st === "running") {
        return { code: "running_step", label: human, detail: null };
      }
      if (st === "error") {
        return {
          code: "step_failed",
          label: "Falhou nesta etapa",
          detail: human,
        };
      }
    }
    return {
      code: "running",
      label: "Sincronizando…",
      detail: "Processamento em segundo plano.",
    };
  }

  return { code: overall, label: null, detail: null };
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export default async function handleMarketplaceAccountSyncStatus(req, res, path) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  const m = path.match(/^\/api\/marketplace\/accounts\/([^/]+)\/sync-status$/);
  const accountId = m?.[1] ?? null;
  if (!accountId || !UUID_REGEX.test(accountId)) {
    return res.status(400).json({ ok: false, error: "ID inválido." });
  }

  try {
    let { data: account, error: accErr } = await supabase
      .from("marketplace_accounts")
      .select(
        "id,status,marketplace,user_id,updated_at,token_expires_at,ml_sales_last_sync_at,external_seller_id,seller_company_id"
      )
      .eq("id", accountId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (
      accErr &&
      (String(accErr.code ?? "") === "42703" || String(accErr.message ?? "").toLowerCase().includes("column"))
    ) {
      const r2 = await supabase
        .from("marketplace_accounts")
        .select("id,status,marketplace,user_id,updated_at,token_expires_at,ml_sales_last_sync_at,external_seller_id")
        .eq("id", accountId)
        .eq("user_id", user.id)
        .maybeSingle();
      account = r2.data;
      accErr = r2.error;
    }

    if (accErr) {
      console.error("[marketplace/sync-status] account_query", accErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar conta." });
    }
    if (!account?.id) {
      return res.status(404).json({ ok: false, error: "Conta não encontrada." });
    }

    const { data: jobRows, error: jobErr } = await supabase
      .from("marketplace_account_sync_jobs")
      .select("*")
      .eq("marketplace_account_id", accountId)
      .in("job_type", ML_ALL_ACCOUNT_SYNC_JOB_TYPES)
      .order("created_at", { ascending: false })
      .limit(400);

    if (jobErr) {
      console.error("[marketplace/sync-status] jobs_query", jobErr);
      return res.status(500).json({ ok: false, error: "Erro ao carregar jobs." });
    }

    const rows = jobRows ?? [];

    const { checklist, historicalSalesAgg, hotAllDone, hasEngagedInitialSync } = buildMlAccountSyncChecklist(
      account,
      rows
    );
    const historicalCustomersAgg = aggregateHistoricalCustomersJobs(rows);

    const coverageRollup = await fetchMlHistoricalCoverageRollupForAccount(
      supabase,
      accountId,
      String(account.marketplace || ML_MARKETPLACE_SLUG)
    );
    const historicalUx = buildMlHistoricalSalesUxState(rows, coverageRollup);
    const checklistWithUx = checklist.map((row) =>
      row.key === "historical_sales" && historicalUx ? { ...row, historical_ux: historicalUx } : row
    );

    const tokenMissingRow = checklistWithUx.find((row) => {
      const em = String(row.error_message ?? "").toLowerCase();
      return em.includes("tokens não encontrados") || em.includes("tokens nao encontrados");
    });
    if (tokenMissingRow) {
      console.warn("[ml/sync-status] tokens_missing_checklist", {
        marketplace_account_id: accountId,
        external_seller_id: account.external_seller_id ?? null,
        seller_company_id: account.seller_company_id ?? null,
        checklist_key: tokenMissingRow.key ?? null,
        job_type: tokenMissingRow.job_type ?? null,
        error_message_preview: String(tokenMissingRow.error_message ?? "").slice(0, 500),
      });
    }

    const gateStatuses = checklist
      .filter((x) => String(x.sync_layer || "") !== "historical")
      .map((x) => String(x.status || ""));

    const typedStatuses = gateStatuses;

    const anyError = typedStatuses.some((s) => s === "error");
    const allDone =
      typedStatuses.length > 0 && typedStatuses.every((s) => s === "done");
    const doneRows = rows.filter((r) => String(r.status || "") === "done");
    const doneRowsGateWarnings = doneRows.filter((r) => !BACKFILL_JOB_TYPE_SET.has(String(r.job_type || "")));
    const hasPartialWarnings = doneRowsGateWarnings.some((r) => {
      const m = r?.metadata && typeof r.metadata === "object" ? r.metadata : {};
      const c = Number(m?.errors_count ?? 0);
      return Number.isFinite(c) && c > 0;
    });
    const runningRows = rows.filter((r) => String(r.status || "") === "running");
    const pendingRows = rows.filter((r) => String(r.status || "") === "pending");
    const latestRunningTs = runningRows
      .map((r) => Date.parse(String(r.updated_at ?? r.created_at ?? "")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a)[0];
    const staleRunning =
      runningRows.length > 0 &&
      Number.isFinite(latestRunningTs) &&
      Date.now() - Number(latestRunningTs) > STALE_PROGRESS_MS;
    const oldestPendingTs = pendingRows
      .map((r) => Date.parse(String(r.updated_at ?? r.created_at ?? "")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)[0];
    const queuedTooLong =
      pendingRows.length > 0 &&
      Number.isFinite(oldestPendingTs) &&
      Date.now() - Number(oldestPendingTs) > PENDING_QUEUE_WARNING_MS;

    let overall = "idle";
    if (!hasEngagedInitialSync) {
      overall = "awaiting_start";
    } else if (typedStatuses.length === 0) {
      overall = "no_jobs";
    } else if (anyError) {
      overall = "error";
    } else if (allDone && hasPartialWarnings) {
      overall = "completed_with_errors";
    } else if (allDone) {
      overall = "done";
    } else {
      overall = "running";
    }

    const integration_stage = resolveIntegrationStage({
      checklist: checklistWithUx,
      overall,
      historical_sales_aggregate: historicalSalesAgg,
      historical_customers_aggregate: historicalCustomersAgg,
      historical_sales_ux: historicalUx,
    });

    const background_note =
      overall === "running"
        ? "Sua sincronização foi iniciada em segundo plano. Você já pode continuar usando o Suse7."
        : null;
    const stalled_warning =
      overall === "running" && staleRunning
        ? "A sincronização está demorando mais que o normal. Estamos tentando continuar em segundo plano."
        : null;
    const pending_queue_warning =
      (overall === "running" || overall === "awaiting_start") && queuedTooLong
        ? "Sincronização enfileirada. Estamos aguardando o processamento em segundo plano."
        : null;

    // Fallback serverless (Hobby sem cron por minuto):
    // quando detectar fila estagnada/pendente por muito tempo, tenta acordar 1 ciclo do drain.
    const shouldNudgeDrain =
      overall === "running" &&
      (staleRunning || queuedTooLong || pendingRows.length > 0);
    const host = req.headers?.host != null ? String(req.headers.host) : "";
    const protoHeader = req.headers?.["x-forwarded-proto"] != null ? String(req.headers["x-forwarded-proto"]) : "";
    const proto = protoHeader.includes("https") ? "https" : "http";
    const drainLimitParsed = parseInt(process.env.MARKETPLACE_SYNC_MAX_JOBS_PER_DRAIN || "24", 10);
    const drainLimit = Number.isFinite(drainLimitParsed) ? Math.min(100, Math.max(1, drainLimitParsed)) : 24;
    const dispatchUrl = host ? `${proto}://${host}/api/jobs/marketplace-account-sync?limit=${drainLimit}` : null;
    if (shouldNudgeDrain && dispatchUrl && (config.jobSecret || config.cronSecret)) {
      const nowMs = Date.now();
      const lastPost = drainNudgeLastPostAtMs.get(accountId) ?? 0;
      if (nowMs - lastPost < DRAIN_NUDGE_COOLDOWN_MS) {
        const lastSkipLog = drainNudgeSkipLogAtMs.get(accountId) ?? 0;
        if (nowMs - lastSkipLog >= DRAIN_NUDGE_SKIP_LOG_COOLDOWN_MS) {
          drainNudgeSkipLogAtMs.set(accountId, nowMs);
          console.info("[S7][marketplace-sync-drain-nudge-skipped-cooldown]", {
            marketplace_account_id: accountId,
            cooldown_ms: DRAIN_NUDGE_COOLDOWN_MS,
            pending_count: pendingRows.length,
          });
        }
      } else {
        drainNudgeLastPostAtMs.set(accountId, nowMs);
        const headers = {};
        if (config.jobSecret) headers["x-job-secret"] = config.jobSecret;
        else if (config.cronSecret) headers.Authorization = `Bearer ${config.cronSecret}`;
        Promise.resolve()
          .then(async () => {
            try {
              const r = await fetch(dispatchUrl, { method: "POST", headers });
              console.info("[S7][marketplace-sync-drain-nudge]", {
                marketplace_account_id: accountId,
                overall,
                staleRunning,
                queuedTooLong,
                pending_count: pendingRows.length,
                drain_http_status: r.status,
              });
            } catch (nudgeErr) {
              console.warn("[S7][marketplace-sync-drain-nudge-warn]", {
                marketplace_account_id: accountId,
                message: nudgeErr?.message ?? String(nudgeErr),
              });
            }
          })
          .catch(() => {});
      }
    }

    const title =
      overall === "running"
        ? "Sincronização em segundo plano"
        : overall === "done" || overall === "completed_with_errors"
          ? "Integração Mercado Livre"
          : overall === "error"
            ? "Sincronização com pendências"
            : "Conta Mercado Livre conectada";

    const historicalBackfillActive = Boolean(
      (historicalSalesAgg &&
        ["pending", "running"].includes(String(historicalSalesAgg.status || "").toLowerCase())) ||
        (historicalCustomersAgg &&
          ["pending", "running"].includes(String(historicalCustomersAgg.status || "").toLowerCase()))
    );

    const mpSlug = String(account.marketplace || ML_MARKETPLACE_SLUG);
    const extForToken =
      account.external_seller_id != null && String(account.external_seller_id).trim() !== ""
        ? String(account.external_seller_id).trim()
        : "";
    const tokenProbe = await fetchMlTokenProbeForMlSeller(supabase, user.id, mpSlug, extForToken, accountId);
    const tokenAligned = !tokenProbe.token_account_mismatch && (!extForToken || tokenProbe.present);
    console.info("[sync-status] token_lookup_by_marketplace_account", {
      marketplace_account_id: accountId,
      user_id: user.id,
      marketplace: mpSlug,
      external_seller_id_for_token: extForToken || null,
      token_present: tokenProbe.present,
      token_account_mismatch: Boolean(tokenProbe.token_account_mismatch),
      resolved_via: tokenProbe.resolved_via ?? null,
    });
    if (tokenProbe.token_account_mismatch) {
      console.error("[sync-status] token_account_mismatch", {
        marketplace_account_id: accountId,
        user_id: user.id,
        external_seller_id: extForToken || null,
      });
    }
    const activePipelineSet = await fetchMarketplaceAccountsWithActiveMlPipeline(
      supabase,
      [accountId],
      String(account.marketplace || ML_MARKETPLACE_SLUG)
    );
    const connectionPack = buildMlConnectionUiPack(
      account,
      tokenProbe,
      activePipelineSet.has(String(accountId))
    );

    const tokenExpMs =
      account?.token_expires_at != null ? Date.parse(String(account.token_expires_at)) : NaN;
    const tokenLikelyExpired =
      Number.isFinite(tokenExpMs) && Date.now() > tokenExpMs - 120000 && !tokenProbe.has_refresh;
    const sales_sync_status =
      String(account?.status || "").toLowerCase() !== "active"
        ? "disconnected"
        : connectionPack.connection_health === "auth_required" || tokenLikelyExpired
          ? "token_expired"
          : historicalBackfillActive || overall === "running"
            ? "running"
            : overall === "error"
              ? "error"
              : "idle";

    const sales_sync_engine = {
      sales_sync_status,
      last_sales_sync_at: account?.ml_sales_last_sync_at ?? null,
      last_sales_sync_error: null,
      last_webhook_received_at: null,
      last_webhook_processed_at: null,
      pending_webhook_events_count: null,
      recent_sales_imported_count: historicalUx?.coverage_saved_total_hint ?? null,
      sales_auto_sync_effective:
        connectionPack.connection_health === "connected" &&
        String(account?.status || "").toLowerCase() === "active",
      historical_period_start: historicalUx?.historical_period_start ?? null,
      historical_period_end: historicalUx?.historical_period_end ?? null,
      current_window_start: historicalUx?.current_window_start ?? null,
      current_window_end: historicalUx?.current_window_end ?? null,
      window_progress_current: historicalUx?.window_progress_current ?? null,
      window_progress_total: historicalUx?.window_progress_total ?? null,
      window_progress_percent: historicalUx?.window_progress_percent ?? null,
      message_pt: historicalUx?.message_pt ?? null,
    };

    const sync_attention_required = syncStatusNeedsAttention({
      overall,
      historical_backfill_active: historicalBackfillActive,
      stalled: staleRunning,
      pending_queued_too_long: queuedTooLong,
      checklist: checklistWithUx,
    });

    const histRunning =
      (historicalSalesAgg &&
        ["pending", "running"].includes(String(historicalSalesAgg.status || "").toLowerCase())) ||
      (historicalCustomersAgg &&
        ["pending", "running"].includes(String(historicalCustomersAgg.status || "").toLowerCase()));

    const description =
      overall === "running"
        ? "Importação em fila no servidor. Você pode fechar esta janela; o status continua nesta página em Integrações."
        : overall === "done"
          ? histRunning
            ? [
                historicalUx?.processing_title || "Importando histórico disponível de vendas…",
                historicalUx?.historical_total_period_line || null,
                historicalUx?.current_window_period_line || null,
                historicalUx?.processing_window_line || null,
              ]
                .filter((x) => x != null && String(x).trim() !== "")
                .join(" ")
            : typeof historicalUx?.modal_success_summary === "string" && historicalUx.modal_success_summary.trim() !== ""
              ? String(historicalUx.modal_success_summary).trim()
              : "Histórico disponível importado com sucesso. O Suse7 passará a armazenar suas vendas futuras de forma permanente."
          : overall === "completed_with_errors"
            ? "Sincronização concluída com alguns avisos — revise as etapas na lista."
            : overall === "error"
              ? "Uma etapa falhou. Você pode tentar de novo ou seguir usando o app enquanto corrigimos."
              : "Conta Mercado Livre conectada com sucesso. Inicie a sincronização quando estiver pronto.";

    return res.status(200).json({
      ok: true,
      marketplace_account_id: accountId,
      token_alignment: {
        aligned: Boolean(tokenAligned && !tokenProbe.token_account_mismatch),
        token_present: Boolean(tokenProbe.present),
        token_account_mismatch: Boolean(tokenProbe.token_account_mismatch),
        resolved_via: tokenProbe.resolved_via ?? null,
        external_seller_id: extForToken || null,
      },
      marketplace: String(account.marketplace || ML_MARKETPLACE_SLUG),
      overall,
      stalled: Boolean(staleRunning),
      stale_threshold_ms: STALE_PROGRESS_MS,
      pending_queued_too_long: Boolean(queuedTooLong),
      pending_warning_threshold_ms: PENDING_QUEUE_WARNING_MS,
      initial_sync_engaged: hasEngagedInitialSync,
      integration_stage,
      sync_background_eligible: overall === "running" || overall === "completed_with_errors",
      background_note,
      stalled_warning,
      pending_queue_warning,
      title,
      description,
      checklist: checklistWithUx,
      ml_historical_sales_ux: historicalUx,
      ml_initial_recent_days: resolveMlInitialRecentDays(),
      historical_sales_sync:
        historicalSalesAgg != null ? { ...historicalSalesAgg, ux: historicalUx } : null,
      historical_customers_sync: historicalCustomersAgg,
      hot_sync_complete: hotAllDone,
      historical_backfill_active: historicalBackfillActive,
      connection: {
        health: connectionPack.connection_health,
        badge_label: connectionPack.connection_badge_label,
        alert_message: connectionPack.connection_alert_message,
        show_reconnect: connectionPack.show_reconnect_cta,
        monitoring_headline: connectionPack.monitoring_headline,
        pipeline_active: connectionPack.pipeline_active,
      },
      sales_sync_engine,
      sync_attention_required,
    });
  } catch (e) {
    console.error("[marketplace/sync-status]", e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
}
