/**
 * CPJ2 T10 — cursor de vendas só avança após persistência durável confirmada.
 * Histórico antigo não pode depender de webhook/poll incremental para reparo.
 */

/**
 * @typedef {{
 *   search_offset: number;
 *   idx_in_page: number;
 *   seller_id: string | null;
 *   persist_fail_oid?: string | null;
 *   persist_fail_count?: number;
 * }} SalesSyncCursor
 */

/**
 * @typedef {{
 *   action: "advance_ok" | "advance_skip" | "hold_yield";
 *   reason: string;
 *   durable: boolean;
 * }} SalesCursorDecision
 */

/**
 * @param {string | null | undefined} raw
 * @returns {SalesSyncCursor}
 */
export function parseSalesCursor(raw) {
  try {
    const o = raw ? JSON.parse(raw) : {};
    const search_offset = Number.isFinite(Number(o.search_offset)) ? Number(o.search_offset) : 0;
    const idx_in_page = Number.isFinite(Number(o.idx_in_page)) ? Number(o.idx_in_page) : 0;
    const seller_id = o.seller_id != null ? String(o.seller_id).trim() : null;
    const persist_fail_oid =
      o.persist_fail_oid != null && String(o.persist_fail_oid).trim() !== ""
        ? String(o.persist_fail_oid).trim()
        : null;
    const persist_fail_count = Number.isFinite(Number(o.persist_fail_count))
      ? Math.max(0, Math.floor(Number(o.persist_fail_count)))
      : 0;
    return { search_offset, idx_in_page, seller_id, persist_fail_oid, persist_fail_count };
  } catch {
    return {
      search_offset: 0,
      idx_in_page: 0,
      seller_id: null,
      persist_fail_oid: null,
      persist_fail_count: 0,
    };
  }
}

/**
 * @param {SalesSyncCursor} c
 */
export function serializeSalesCursor(c) {
  return JSON.stringify({
    search_offset: c.search_offset,
    idx_in_page: c.idx_in_page,
    seller_id: c.seller_id ?? null,
    persist_fail_oid: c.persist_fail_oid ?? null,
    persist_fail_count: c.persist_fail_count ?? 0,
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} detail
 */
export function isCancelledMlOrderDetail(detail) {
  const status = detail?.status != null ? String(detail.status).toLowerCase() : "";
  return status === "cancelled";
}

/**
 * Persistência durável = ok explícito. `ok:false` (lookup/upsert/entitlement) não avança.
 * @param {unknown} persistResult
 */
export function isDurableSalesPersistSuccess(persistResult) {
  if (!persistResult || typeof persistResult !== "object") return false;
  return /** @type {{ ok?: unknown }} */ (persistResult).ok === true;
}

/**
 * Pedido sem identidade não é recuperável — skip confirmado, não é perda de venda.
 * @param {unknown} persistResult
 */
export function isConfirmedInvalidOrderSkip(persistResult) {
  if (!persistResult || typeof persistResult !== "object") return false;
  const reason = String(/** @type {{ reason?: unknown }} */ (persistResult).reason || "");
  return reason === "order_without_id";
}

/**
 * @param {{
 *   skippedDeadline?: boolean;
 *   backoffYield?: boolean;
 *   fetchError?: unknown;
 *   detail?: Record<string, unknown> | null;
 *   persistResult?: { ok?: boolean; reason?: string } | null;
 *   persistError?: unknown;
 *   timedOut?: boolean;
 * }} attempt
 * @returns {SalesCursorDecision}
 */
export function resolveSalesCursorDecision(attempt) {
  if (attempt.skippedDeadline) {
    return { action: "hold_yield", reason: "deadline_before_detail", durable: false };
  }
  if (attempt.backoffYield) {
    return { action: "hold_yield", reason: "ml_backoff_yield", durable: false };
  }
  if (attempt.fetchError) {
    return { action: "hold_yield", reason: "fetch_failed", durable: false };
  }
  if (attempt.detail == null) {
    return { action: "hold_yield", reason: "detail_null", durable: false };
  }
  if (isCancelledMlOrderDetail(attempt.detail)) {
    return { action: "advance_skip", reason: "cancelled", durable: true };
  }
  if (attempt.timedOut) {
    return { action: "hold_yield", reason: "persist_timeout", durable: false };
  }
  if (attempt.persistError) {
    return { action: "hold_yield", reason: "persist_failed", durable: false };
  }
  if (attempt.persistResult == null) {
    return { action: "hold_yield", reason: "persist_missing_result", durable: false };
  }
  if (isDurableSalesPersistSuccess(attempt.persistResult)) {
    return { action: "advance_ok", reason: "persist_ok", durable: true };
  }
  if (isConfirmedInvalidOrderSkip(attempt.persistResult)) {
    return { action: "advance_skip", reason: "order_without_id", durable: true };
  }
  const reason = String(attempt.persistResult.reason || "persist_not_ok");
  return { action: "hold_yield", reason, durable: false };
}

/**
 * Avança só o índice do pedido confirmado. Falha não mexe em search_offset.
 * @param {SalesSyncCursor} cursor
 */
export function advanceSalesCursorAfterConfirmedOrder(cursor) {
  return {
    ...cursor,
    idx_in_page: cursor.idx_in_page + 1,
    persist_fail_oid: null,
    persist_fail_count: 0,
  };
}

/**
 * @param {SalesSyncCursor} cursor
 * @param {string} oid
 */
export function holdSalesCursorOnPersistFailure(cursor, oid) {
  const same = cursor.persist_fail_oid === String(oid);
  return {
    ...cursor,
    persist_fail_oid: String(oid),
    persist_fail_count: same ? (cursor.persist_fail_count || 0) + 1 : 1,
  };
}

/**
 * Lote já persistido em parte: o cursor aponta para o primeiro NÃO confirmado.
 * Reprocessar o restante é upsert idempotente — trabalho duplicado aceito.
 * @param {string[]} sliceOrderIds
 * @param {number} idxInPageAtSliceStart
 * @param {SalesSyncCursor} cursorAfter
 */
export function remainingOrderIdsForRetry(sliceOrderIds, idxInPageAtSliceStart, cursorAfter) {
  const start = Math.max(0, cursorAfter.idx_in_page - idxInPageAtSliceStart);
  return sliceOrderIds.slice(start);
}
