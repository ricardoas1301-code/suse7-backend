// ======================================================================
// UX / copy para histórico de vendas ML — fonte de verdade no backend (sync-status).
// ======================================================================

import { aggregateHistoricalSalesJobs } from "./mlAccountSyncChecklist.js";

/** Mensagem institucional (transparência + valor do Suse7 como memória permanente). */
export const ML_HISTORICAL_INSTITUTIONAL_MESSAGE =
  "O Suse7 resgata imediatamente todo o histórico disponível no Mercado Livre (até 12 meses).\n\n" +
  "A partir deste momento, suas vendas passam a fazer parte do catálogo histórico do Suse7. Isso significa que o sistema continuará armazenando automaticamente cada nova venda, atualização e indicador de performance de forma permanente.\n\n" +
  "Assim, ao longo do tempo, você poderá acompanhar anos de evolução do seu negócio, métricas, produtos, margens e crescimento — algo que a API do Mercado Livre não disponibiliza retroativamente.";

export const ML_HISTORICAL_MODAL_SUCCESS_SUMMARY =
  "Histórico disponível importado com sucesso.\n\n" +
  "O Mercado Livre disponibiliza acesso retroativo limitado ao histórico de vendas. A partir de agora, o Suse7 continuará armazenando automaticamente suas novas vendas e indicadores históricos de forma permanente.";

export const ML_HISTORICAL_DIVERGENCE_NOTICE =
  "Algumas vendas retornadas pela API podem não ter sido importadas por duplicidade, cancelamento ou indisponibilidade do Marketplace.";

/** @param {Record<string, unknown> | null | undefined} job */
export function readJobMetadata(job) {
  const m = job?.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? /** @type {Record<string, unknown>} */ (m) : {};
}

/**
 * @param {Record<string, unknown>[]} coverageRows
 * @returns {{ saved_total_sum: number; api_total_sum: number; period_from: string | null; period_to: string | null; row_count: number } | null}
 */
export function rollupMlHistoricalCoverageRows(coverageRows) {
  if (!Array.isArray(coverageRows) || coverageRows.length === 0) return null;
  let saved = 0;
  let api = 0;
  /** @type {number | null} */
  let minFrom = null;
  /** @type {number | null} */
  let maxTo = null;
  for (const r of coverageRows) {
    saved += Number(r.saved_total) || 0;
    api += Number(r.api_total) || 0;
    const df = r.date_from != null ? Date.parse(String(r.date_from)) : NaN;
    const dt = r.date_to != null ? Date.parse(String(r.date_to)) : NaN;
    if (Number.isFinite(df)) minFrom = minFrom == null ? df : Math.min(minFrom, df);
    if (Number.isFinite(dt)) maxTo = maxTo == null ? dt : Math.max(maxTo, dt);
  }
  return {
    saved_total_sum: saved,
    api_total_sum: api,
    period_from: minFrom != null ? new Date(minFrom).toISOString() : null,
    period_to: maxTo != null ? new Date(maxTo).toISOString() : null,
    row_count: coverageRows.length,
  };
}

/** @param {string | null | undefined} iso */
function formatPtDateShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return String(iso).slice(0, 10);
  }
}

/**
 * @param {string | null | undefined} fromIso
 * @param {string | null | undefined} toIso
 */
export function formatHistoricalPeriodLine(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return `Período atual: ${formatPtDateShort(fromIso)} até ${formatPtDateShort(toIso)}`;
}

/**
 * @param {string | null | undefined} fromIso
 * @param {string | null | undefined} toIso
 */
export function formatHistoricalTotalPeriodLine(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return `Histórico total: ${formatPtDateShort(fromIso)} até ${formatPtDateShort(toIso)}`;
}

/**
 * @param {string | null | undefined} fromIso
 * @param {string | null | undefined} toIso
 */
export function formatCurrentWindowPeriodLine(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return `Janela atual: ${formatPtDateShort(fromIso)} até ${formatPtDateShort(toIso)}`;
}

/**
 * @param {Record<string, unknown>[]} jobRows — marketplace_account_sync_jobs da conta
 * @param {ReturnType<typeof rollupMlHistoricalCoverageRows>} coverageRollup
 */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} accountId
 * @param {string} marketplace
 */
export async function fetchMlHistoricalCoverageRollupForAccount(supabase, accountId, marketplace) {
  try {
    const { data, error } = await supabase
      .from("marketplace_account_sales_import_coverage")
      .select("saved_total, api_total, date_from, date_to, status, updated_at")
      .eq("marketplace_account_id", accountId)
      .eq("marketplace", marketplace)
      .eq("sync_type", "ml_historical_sales_backfill")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) return null;
    return rollupMlHistoricalCoverageRows(data ?? []);
  } catch {
    return null;
  }
}

export function buildMlHistoricalSalesUxState(jobRows, coverageRollup) {
  const agg = aggregateHistoricalSalesJobs(jobRows);
  if (!agg) return null;

  const hs = jobRows.filter((r) => String(r.job_type || "") === "ml_historical_sales_backfill");
  hs.sort((a, b) => {
    const ma = readJobMetadata(a);
    const mb = readJobMetadata(b);
    const wa = Number(ma.window_index);
    const wb = Number(mb.window_index);
    if (Number.isFinite(wa) && Number.isFinite(wb) && wa !== wb) return wa - wb;
    const ta = Date.parse(String(a.created_at || 0));
    const tb = Date.parse(String(b.created_at || 0));
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  });

  const running = hs.find((r) => String(r.status || "").toLowerCase() === "running");
  const pendingFirst = hs.find((r) => String(r.status || "").toLowerCase() === "pending");
  const focal = running || pendingFirst || null;
  const fm = focal ? readJobMetadata(focal) : {};
  let histStart = fm.historical_period_start != null ? String(fm.historical_period_start).trim() : null;
  let histEnd = fm.historical_period_end != null ? String(fm.historical_period_end).trim() : null;
  if (!histStart || !histEnd) {
    for (const r of hs) {
      const m = readJobMetadata(r);
      if (!histStart && m.historical_period_start) histStart = String(m.historical_period_start).trim();
      if (!histEnd && m.historical_period_end) histEnd = String(m.historical_period_end).trim();
      if (histStart && histEnd) break;
    }
  }
  const dateFrom = fm.date_from != null ? String(fm.date_from).trim() : null;
  const dateTo = fm.date_to != null ? String(fm.date_to).trim() : null;
  const wi = Number(fm.window_index);
  const windowIndex0 = Number.isFinite(wi) ? wi : null;
  const windowsTotal = hs.length;
  const windowPosition1 =
    windowIndex0 != null && windowsTotal > 0 ? Math.min(windowsTotal, windowIndex0 + 1) : null;

  let savedFromMeta = 0;
  let apiFromMeta = 0;
  let errorsFromMeta = 0;
  let hasDivergenceMeta = false;
  for (const r of hs) {
    const st = String(r.status || "").toLowerCase();
    const m = readJobMetadata(r);
    if (st === "done") {
      savedFromMeta += Number(m.ml_sales_import_saved) || 0;
      apiFromMeta += Number(m.ml_sales_import_api_total) || Number(r.progress_total) || 0;
    }
    errorsFromMeta += Number(m.errors_count) || 0;
    if (m.ml_sales_api_total_divergence != null) hasDivergenceMeta = true;
  }

  const savedHint =
    coverageRollup != null && coverageRollup.saved_total_sum > 0
      ? coverageRollup.saved_total_sum
      : savedFromMeta > 0
        ? savedFromMeta
        : Number(agg.progress_current) || 0;

  const apiHint =
    coverageRollup != null && coverageRollup.api_total_sum > 0
      ? coverageRollup.api_total_sum
      : apiFromMeta > 0
        ? apiFromMeta
        : Number(agg.progress_total) || null;

  const periodFrom = coverageRollup?.period_from ?? dateFrom;
  const periodTo = coverageRollup?.period_to ?? dateTo;

  const status = String(agg.status || "").toLowerCase();
  const isActive = status === "running" || status === "pending";

  const processingTitle = "Importando histórico disponível de vendas…";
  const historical_total_period_line = formatHistoricalTotalPeriodLine(histStart, histEnd);
  const current_window_period_line = formatCurrentWindowPeriodLine(dateFrom, dateTo);
  /** @deprecated Prefer historical_total_period_line + current_window_period_line */
  const processingPeriodLine = current_window_period_line;

  const windowLine =
    windowPosition1 != null && windowsTotal > 0
      ? `Processando janela ${windowPosition1} de ${windowsTotal}`
      : windowsTotal > 0
        ? `${windowsTotal} janelas de importação`
        : null;

  const savedLine =
    savedHint > 0
      ? `${Math.round(savedHint)} vendas salvas no Suse7`
      : isActive
        ? "Preparando importação…"
        : null;

  const processedLine =
    Number(agg.progress_current) > 0
      ? `${Math.round(Number(agg.progress_current))} pedidos processados na API (todas as janelas)`
      : null;

  const windowsProgressPercent =
    windowsTotal > 0 && agg.windows_done != null
      ? Math.min(100, Math.round((100 * Number(agg.windows_done)) / windowsTotal))
      : null;

  /** @type {string[]} */
  const checklistDetailLines = [];
  if (isActive) {
    if (historical_total_period_line) checklistDetailLines.push(historical_total_period_line);
    if (current_window_period_line) checklistDetailLines.push(current_window_period_line);
    if (windowLine) checklistDetailLines.push(windowLine);
    if (savedHint > 0 && savedLine) checklistDetailLines.push(savedLine);
    else if (processedLine) checklistDetailLines.push(processedLine);
    else if (!current_window_period_line) checklistDetailLines.push("Aguardando primeira página de resultados…");
  } else if (status === "done") {
    if (periodFrom && periodTo) {
      checklistDetailLines.push(`Período importado: ${formatPtDateShort(periodFrom)} até ${formatPtDateShort(periodTo)}`);
    }
    if (apiHint != null && Number.isFinite(apiHint) && apiHint > 0) {
      checklistDetailLines.push(`Vendas localizadas na API: ${Math.round(apiHint)}`);
    }
    if (savedHint > 0) {
      checklistDetailLines.push(`Vendas salvas no Suse7: ${Math.round(savedHint)}`);
    }
    checklistDetailLines.push("Cobertura disponível importada.");
  } else if (status === "error") {
    checklistDetailLines.push("Toque em suporte ou reative a sincronização para tentar novamente.");
  }

  const showDivergence = errorsFromMeta > 0 || hasDivergenceMeta;

  const completionLine1 = "Histórico disponível importado.";
  const completionLine2 = "Novas vendas e atualizações serão monitoradas automaticamente.";

  const message_pt = isActive
    ? "Importação histórica em andamento no servidor."
    : status === "done"
      ? "Histórico disponível importado."
      : status === "error"
        ? "Falha ao importar parte do histórico."
        : "Aguardando importação histórica.";

  return {
    institutional_message: ML_HISTORICAL_INSTITUTIONAL_MESSAGE,
    modal_success_summary: ML_HISTORICAL_MODAL_SUCCESS_SUMMARY,
    processing_title: processingTitle,
    historical_total_period_line,
    current_window_period_line,
    processing_period_line: processingPeriodLine,
    processing_window_line: windowLine,
    completion_line_1: completionLine1,
    completion_line_2: completionLine2,
    coverage_period_from: periodFrom,
    coverage_period_to: periodTo,
    coverage_api_total_hint: apiHint,
    coverage_saved_total_hint: savedHint,
    divergence_notice: showDivergence ? ML_HISTORICAL_DIVERGENCE_NOTICE : null,
    checklist_primary: isActive ? processingTitle : status === "done" ? "Histórico disponível (Mercado Livre)" : "Histórico de vendas",
    checklist_detail_lines: checklistDetailLines,
    hide_raw_progress_fraction: true,
    /** Metadados para o cliente sem depender de cópia embutida */
    state: status,
    windows_total: windowsTotal,
    windows_done: agg.windows_done,
    focal_date_from: dateFrom,
    focal_date_to: dateTo,
    historical_period_start: histStart,
    historical_period_end: histEnd,
    current_window_start: dateFrom,
    current_window_end: dateTo,
    window_progress_current: windowPosition1,
    window_progress_total: windowsTotal,
    window_progress_percent: windowsProgressPercent,
    message_pt,
  };
}
