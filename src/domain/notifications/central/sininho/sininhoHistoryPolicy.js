// =============================================================================
// S7 — Central Sininho (Fase S5.8) — política de histórico (infra)
// Timeline, leitura, arquivamento e deep-links — sem regras de negócio.
// =============================================================================

import {
  S7_SININHO_ARCHIVE_STATE,
  S7_SININHO_READ_STATE,
} from "./sininhoChannelContract.js";

const SEVERITIES = new Set(["info", "warning", "critical"]);

/**
 * @param {string} severity
 */
export function isValidSininhoSeverity(severity) {
  return SEVERITIES.has(String(severity ?? "").trim().toLowerCase());
}

/**
 * Resolve estado de leitura a partir de colunas ou metadata.inbox.
 * @param {{ is_read?: boolean; read_at?: string | null; metadata?: Record<string, unknown> }} row
 */
export function resolveSininhoReadState(row = {}) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const inbox = meta.inbox && typeof meta.inbox === "object" ? meta.inbox : {};
  const read =
    row.is_read === true ||
    inbox.is_read === true ||
    row.read_at != null ||
    inbox.read_at != null;
  return read ? S7_SININHO_READ_STATE.READ : S7_SININHO_READ_STATE.UNREAD;
}

/**
 * Resolve estado de arquivamento (preparado — archived_at futuro).
 * @param {{ archived_at?: string | null }} row
 */
export function resolveSininhoArchiveState(row = {}) {
  if (row.archived_at != null && String(row.archived_at).trim() !== "") {
    return S7_SININHO_ARCHIVE_STATE.ARCHIVED;
  }
  return S7_SININHO_ARCHIVE_STATE.ACTIVE;
}

/**
 * Monta entrada de timeline para auditoria (puro, sem I/O).
 * @param {Record<string, unknown>} input
 */
export function buildSininhoTimelineEntry(input = {}) {
  const readState = resolveSininhoReadState({
    is_read: input.is_read,
    read_at: input.read_at,
    metadata: input.metadata,
  });
  const archiveState = resolveSininhoArchiveState({ archived_at: input.archived_at });

  return {
    dispatch_id: input.id ?? input.dispatch_id ?? null,
    event_id: input.event_id ?? null,
    seller_id: input.seller_id ?? null,
    category_code: input.category_code ?? null,
    type_key: input.type_key ?? null,
    title: input.title ?? input.rendered_subject ?? "",
    message: input.message ?? input.rendered_body ?? "",
    severity: isValidSininhoSeverity(input.severity) ? String(input.severity).toLowerCase() : "info",
    read_state: readState,
    archive_state: archiveState,
    deep_link: input.deep_link ?? null,
    status: input.status ?? null,
    created_at: input.created_at ?? null,
    read_at: input.read_at ?? null,
    archived_at: input.archived_at ?? null,
  };
}
