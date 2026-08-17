// =============================================================================
// S7 — Dispatcher Central (Fase S5.2)
// Resumo de status por canal + resultado final consolidado.
//
// Backend como fonte de verdade: o frontend consome este estado pronto.
// Duas vias:
//   - summarizeChannelStatusFromDispatches(): puro, a partir do resultado do
//     dispatcher em memória (sem I/O).
//   - summarizeEventChannelStatus(): lê o estado PERSISTIDO por evento (read API).
// =============================================================================

import { S7_NOTIFICATION_DISPATCH_STATUS } from "../constants/dispatchStatus.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";

/**
 * Resultado final consolidado do evento (derivado dos status por canal).
 * @type {const}
 */
export const S7_DISPATCH_FINAL_RESULT = Object.freeze({
  DELIVERED: "delivered", // ao menos 1 canal SENT e nenhum pendente
  IN_PROGRESS: "in_progress", // há canais ainda em andamento (QUEUED/PROCESSING/...)
  PARTIAL: "partial", // terminou com mistura de sucesso e falha
  FAILED: "failed", // todos os canais falharam
  SKIPPED: "skipped", // todos os canais foram pulados/deduplicados
  EMPTY: "empty", // nenhum canal/dispatch
});

const S = S7_NOTIFICATION_DISPATCH_STATUS;

/**
 * Deriva o resultado final a partir da contagem agregada de status.
 * @param {Record<string, number>} counts
 * @returns {string}
 */
export function resolveFinalResult(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return S7_DISPATCH_FINAL_RESULT.EMPTY;

  const sent = counts[S.SENT] ?? 0;
  const failed = counts[S.FAILED] ?? 0;
  const skipped = (counts[S.SKIPPED] ?? 0) + (counts[S.DEDUPED] ?? 0);
  const inFlight =
    (counts[S.PENDING] ?? 0) +
    (counts[S.PROCESSING] ?? 0) +
    (counts[S.QUEUED] ?? 0) +
    (counts[S.RETRY_SCHEDULED] ?? 0);

  if (inFlight > 0) return S7_DISPATCH_FINAL_RESULT.IN_PROGRESS;
  if (sent > 0 && failed === 0) return S7_DISPATCH_FINAL_RESULT.DELIVERED;
  if (sent > 0 && failed > 0) return S7_DISPATCH_FINAL_RESULT.PARTIAL;
  if (failed > 0) return S7_DISPATCH_FINAL_RESULT.FAILED;
  if (skipped === total) return S7_DISPATCH_FINAL_RESULT.SKIPPED;
  return S7_DISPATCH_FINAL_RESULT.PARTIAL;
}

/**
 * @param {Array<{ channel?: string; status?: string }>} rows
 * @returns {{
 *   channels: Record<string, { status: string; count: number }>;
 *   status_counts: Record<string, number>;
 *   total: number;
 *   final_result: string;
 * }}
 */
function summarizeRows(rows) {
  /** @type {Record<string, { status: string; count: number }>} */
  const channels = {};
  /** @type {Record<string, number>} */
  const statusCounts = {};

  for (const row of Array.isArray(rows) ? rows : []) {
    const channel = String(row.channel ?? "unknown");
    const status = String(row.status ?? S.PENDING).toUpperCase();

    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    // Último status visto por canal vence (resumo "estado atual do canal").
    channels[channel] = {
      status,
      count: (channels[channel]?.count ?? 0) + 1,
    };
  }

  return {
    channels,
    status_counts: statusCounts,
    total: Array.isArray(rows) ? rows.length : 0,
    final_result: resolveFinalResult(statusCounts),
  };
}

/**
 * Resumo a partir do resultado do dispatcher em memória (sem I/O).
 * Aceita o array `dispatches` retornado pelo actions engine.
 * @param {Array<{ channel?: string; status?: string }>} dispatches
 */
export function summarizeChannelStatusFromDispatches(dispatches) {
  return summarizeRows(dispatches);
}

/**
 * Resumo a partir do estado PERSISTIDO de um evento (read API p/ frontend/DevCenter).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} eventId
 */
export async function summarizeEventChannelStatus(supabase, eventId) {
  const id = String(eventId ?? "").trim();
  if (!id) return { ok: false, error: "MISSING_EVENT_ID" };

  const { data, error } = await supabase
    .from("s7_notification_dispatches")
    .select("channel, status")
    .eq("event_id", id);

  if (error) {
    logCentralNotification("DISPATCH_STATUS_SUMMARY_ERR", { event_id: id, message: error.message });
    return { ok: false, error: error.message };
  }

  return { ok: true, event_id: id, ...summarizeRows(data ?? []) };
}
