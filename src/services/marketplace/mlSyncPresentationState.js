// ======================================================================
// Estado de apresentação da sincronização ML — SSOT derivado (sync-status).
// Separa overall técnico (hot/gate) do rótulo executivo para o seller.
// ======================================================================

/**
 * @param {unknown} status
 * @returns {"completed" | "error" | "running" | "pending"}
 */
export function resolveMlSyncStepBucket(status) {
  const normalized = String(status || "pending").toLowerCase();
  if (normalized === "done" || normalized === "completed") return "completed";
  if (normalized === "error" || normalized === "failed") return "error";
  if (normalized === "running" || normalized === "processing") return "running";
  return "pending";
}

/**
 * Progresso persistido incompleto (ex.: Anúncios 20/27 após soft-yield).
 * Stub de maintenance 1/1 não conta.
 * @param {Record<string, unknown> | null | undefined} step
 */
export function isMlSyncStepIncompletePersistedProgress(step) {
  const metadata =
    step?.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
      ? /** @type {Record<string, unknown>} */ (step.metadata)
      : {};
  if (metadata.skipped === true) {
    const reason = String(metadata.reason ?? "").trim();
    const metaStep = String(metadata.step ?? "").trim();
    if (reason === "DEV_GLOBAL_MAINTENANCE" || metaStep === "dev_global_maintenance_mode") {
      return false;
    }
  }
  const current = Number(step?.progress_current);
  const total = Number(step?.progress_total);
  if (!Number.isFinite(current) || !Number.isFinite(total)) return false;
  return total > 1 && current > 0 && current < total;
}

/**
 * Contagem canônica para UI (exclui etapas ocultas ao seller).
 * @param {Array<{ key?: string; status?: string }>} checklist
 * @param {ReadonlySet<string>} [hiddenKeys]
 */
export function countMlSyncStepBuckets(checklist, hiddenKeys = new Set(["customers"])) {
  /** @type {{ completed: number; error: number; pending: number; running: number; runningStepLabel: string }} */
  const counts = { completed: 0, error: 0, pending: 0, running: 0, runningStepLabel: "" };

  for (const step of checklist || []) {
    const key = String(step?.key || "");
    if (hiddenKeys.has(key)) continue;
    let bucket = resolveMlSyncStepBucket(step?.status);
    if (bucket === "pending" && isMlSyncStepIncompletePersistedProgress(step)) {
      bucket = "running";
    }
    counts[bucket] += 1;
    if (bucket === "running" && !counts.runningStepLabel) {
      counts.runningStepLabel = String(step?.label || "").trim();
    }
  }

  return counts;
}

/**
 * Histórico concluído sem registros importáveis — conclusão válida (empty-success).
 * @param {Record<string, unknown> | null | undefined} historicalUx
 * @param {Record<string, unknown> | null | undefined} historicalSalesAgg
 */
export function isMlHistoricalEmptySuccess(historicalUx, historicalSalesAgg) {
  if (!historicalSalesAgg) return false;
  if (String(historicalSalesAgg.status || "").toLowerCase() !== "done") return false;
  if (historicalUx?.empty_history === true) return true;
  const saved = Number(historicalUx?.coverage_saved_total_hint) || 0;
  const api = Number(historicalUx?.coverage_api_total_hint) || 0;
  return saved <= 0 && api <= 0;
}

/**
 * @param {{
 *   overall: string;
 *   historicalBackfillActive?: boolean;
 *   historicalSalesAgg?: Record<string, unknown> | null;
 *   historicalUx?: Record<string, unknown> | null;
 *   completedCount?: number;
 *   pendingCount?: number;
 *   errorCount?: number;
 *   runningCount?: number;
 *   runningStepLabel?: string;
 * }} ctx
 */
export function resolveMlSellerSyncPresentationState(ctx) {
  const overall = String(ctx.overall || "").toLowerCase();
  const historicalActive = ctx.historicalBackfillActive === true;
  const runningCount = Number(ctx.runningCount) || 0;
  const errorCount = Number(ctx.errorCount) || 0;
  const pendingCount = Number(ctx.pendingCount) || 0;
  const runningStepLabel =
    runningCount > 0 ? String(ctx.runningStepLabel || "").trim() || "Sincronização" : "";

  const emptyHistory = isMlHistoricalEmptySuccess(ctx.historicalUx, ctx.historicalSalesAgg);

  let displayOverall = overall;
  /** @type {"ok" | "processing" | "warn" | "error" | "unknown"} */
  let summaryTone = "unknown";
  let summaryLabel = "Integração Mercado Livre";
  let sellerHeadline = summaryLabel;

  if (overall === "error" || errorCount > 0) {
    displayOverall = "error";
    summaryTone = "error";
    summaryLabel = "Com pendências";
    sellerHeadline = "Sincronização com pendências";
  } else if (historicalActive || runningCount > 0 || overall === "running") {
    displayOverall = historicalActive && overall === "done" ? "background_sync" : "running";
    summaryTone = "processing";
    summaryLabel = "Em andamento";
    sellerHeadline = historicalActive && overall === "done" ? "Importação histórica em andamento" : "Sincronização em andamento";
  } else if (overall === "completed_with_errors") {
    displayOverall = "completed_with_errors";
    summaryTone = "warn";
    summaryLabel = "Concluído com avisos";
    sellerHeadline = summaryLabel;
  } else if (overall === "done") {
    // Badge terminal só quando NÃO há etapa obrigatória pendente/running/erro
    // (counters/checklist incluem historical; overall hot-only não basta).
    if (pendingCount > 0 || runningCount > 0 || errorCount > 0) {
      displayOverall = runningCount > 0 || historicalActive ? "running" : "background_sync";
      summaryTone = errorCount > 0 ? "error" : "processing";
      summaryLabel = errorCount > 0 ? "Com pendências" : runningCount > 0 ? "Em andamento" : "Com pendências";
      sellerHeadline =
        errorCount > 0
          ? "Sincronização com pendências"
          : historicalActive
            ? "Importação histórica em andamento"
            : "Sincronização com etapas pendentes";
    } else {
      displayOverall = "done";
      summaryTone = "ok";
      summaryLabel = "Concluída";
      sellerHeadline = "Integração Mercado Livre";
    }
  } else if (pendingCount > 0) {
    summaryTone = "warn";
    summaryLabel = "Com pendências";
    sellerHeadline = summaryLabel;
  }

  const fullyComplete =
    overall === "done" &&
    !historicalActive &&
    runningCount === 0 &&
    errorCount === 0 &&
    pendingCount === 0;

  return {
    display_overall: displayOverall,
    sync_summary_label: summaryLabel,
    sync_summary_tone: summaryTone,
    seller_headline: sellerHeadline,
    historical_empty_success: emptyHistory,
    historical_active: historicalActive,
    fully_complete: fullyComplete,
    running_step_label: runningStepLabel || null,
  };
}
