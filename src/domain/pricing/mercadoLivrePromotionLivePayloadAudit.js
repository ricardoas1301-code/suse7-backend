// ======================================================
// S1.PROMO-LIVE-PAYLOAD-FINAL-PARITY — freshness + audit logs
// S1.PROMO-LIVE-ON-OPEN-GLOBAL-PARITY-GUARD — modal open guard
// ======================================================

import crypto from "node:crypto";
import { normalizePromotionRowForFreshnessHash } from "./mercadoLivrePromotionSsotFreshnessAudit.js";

/** TTL curto — payload live obrigatório para Modal PI. */
export const PROMOTION_LIVE_PAYLOAD_TTL_MS = 2 * 60 * 1000;

/** @returns {boolean} */
export function isS7PromotionDebugEnabled() {
  const v = process.env.S7_PROMOTION_DEBUG;
  return v === "1" || String(v).toLowerCase() === "true";
}

/** @returns {boolean} */
function shouldEmitPromotionAuditLog() {
  return process.env.NODE_ENV !== "production" || process.env.S7_PROMOTIONS_PI_AUDIT === "1";
}

/** @param {unknown} value */
function stableJsonStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (value)).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableJsonStringify(/** @type {Record<string, unknown>} */ (value)[k])}`
    )
    .join(",")}}`;
}

/** @param {unknown} value @returns {string | null} */
export function hashPromotionPayloadSignature(value) {
  if (value == null) return null;
  return crypto.createHash("sha256").update(stableJsonStringify(value)).digest("hex").slice(0, 16);
}

/**
 * @param {string | null | undefined} receivedAtIso
 * @returns {number | null}
 */
export function computePromotionPayloadAgeMs(receivedAtIso) {
  if (receivedAtIso == null || String(receivedAtIso).trim() === "") return null;
  const ms = Date.parse(String(receivedAtIso));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Date.now() - ms);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string | null}
 */
export function hashDbSnapshotPromotionSignature(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalized = rows
    .filter((r) => r != null && typeof r === "object")
    .map((r) => normalizePromotionRowForFreshnessHash(/** @type {Record<string, unknown>} */ (r)))
    .sort((a, b) =>
      String(a.id ?? a.offer_id ?? "").localeCompare(String(b.id ?? b.offer_id ?? ""))
    );
  return hashPromotionPayloadSignature(normalized);
}

/**
 * Guard de freshness ao abrir Modal PI (aba Promoções).
 * @param {{
 *   listingExternalId?: string | null;
 *   dbSnapshotUpdatedAt?: string | null;
 *   dbSnapshotRows?: Record<string, unknown>[];
 *   persistedPromoCount?: number;
 *   ttlMs?: number;
 * }} ctx
 */
export function evaluateModalOpenPromotionFreshnessGuard(ctx = {}) {
  const ttlMs = ctx.ttlMs ?? PROMOTION_LIVE_PAYLOAD_TTL_MS;
  const dbAgeMs = computePromotionPayloadAgeMs(ctx.dbSnapshotUpdatedAt);
  const dbSignature = hashDbSnapshotPromotionSignature(ctx.dbSnapshotRows ?? []);
  const staleByAge = dbAgeMs != null && dbAgeMs > ttlMs;
  const noSnapshotTimestamp = dbAgeMs == null && (ctx.dbSnapshotRows?.length ?? 0) > 0;

  return {
    listing_external_id: ctx.listingExternalId ?? null,
    promotion_payload_age_ms: dbAgeMs,
    promotion_payload_signature: dbSignature,
    promotion_payload_source: staleByAge || noSnapshotTimestamp ? "cache_stale_candidate" : "cache_fresh_candidate",
    promotion_payload_ttl_ms: ttlMs,
    force_live_bypass: true,
    cache_stale_by_age: staleByAge || noSnapshotTimestamp,
    persisted_promo_count: ctx.persistedPromoCount ?? 0,
    db_snapshot_updated_at: ctx.dbSnapshotUpdatedAt ?? null,
  };
}

/**
 * @param {{
 *   rawRow?: Record<string, unknown> | null;
 *   pipelinePromoSource?: string | null;
 *   liveFetchOk?: boolean;
 *   payloadReceivedAt?: string | null;
 *   cacheHit?: boolean;
 *   cacheAgeMs?: number | null;
 *   blockedStale?: boolean;
 * }} ctx
 */
export function buildPromotionLivePayloadMeta(ctx = {}) {
  const receivedAt =
    ctx.payloadReceivedAt != null ? String(ctx.payloadReceivedAt) : new Date().toISOString();
  const receivedMs = Date.parse(receivedAt);
  const ageMs =
    ctx.cacheAgeMs != null && Number.isFinite(Number(ctx.cacheAgeMs))
      ? Number(ctx.cacheAgeMs)
      : Number.isFinite(receivedMs)
        ? Math.max(0, Date.now() - receivedMs)
        : null;

  const liveFetchOk = ctx.liveFetchOk === true;
  const blockedStale = ctx.blockedStale === true;
  const cacheHit = ctx.cacheHit === true;
  const staleByAge = ageMs != null && ageMs > PROMOTION_LIVE_PAYLOAD_TTL_MS;

  /** @type {"live" | "cache_fresh" | "cache_stale_blocked"} */
  let promotionPayloadSource = "live";
  if (blockedStale || (cacheHit && staleByAge && !liveFetchOk)) {
    promotionPayloadSource = "cache_stale_blocked";
  } else if (cacheHit && !liveFetchOk) {
    promotionPayloadSource = staleByAge ? "cache_stale_blocked" : "cache_fresh";
  } else if (!liveFetchOk && ctx.pipelinePromoSource === "db_snapshot") {
    promotionPayloadSource = staleByAge ? "cache_stale_blocked" : "cache_fresh";
  } else if (!liveFetchOk && ctx.pipelinePromoSource === "cache_stale_blocked") {
    promotionPayloadSource = "cache_stale_blocked";
  }

  const rawRow = ctx.rawRow ?? null;
  const signature = rawRow
    ? hashPromotionPayloadSignature(normalizePromotionRowForFreshnessHash(rawRow))
    : null;

  return {
    payload_live_received_at: receivedAt,
    promotion_payload_source: promotionPayloadSource,
    promotion_payload_age_ms: ageMs,
    promotion_payload_signature: signature,
    promotion_payload_ttl_ms: PROMOTION_LIVE_PAYLOAD_TTL_MS,
    promotion_payload_stale_blocked: promotionPayloadSource === "cache_stale_blocked",
  };
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionLivePayloadAudit(payload = {}) {
  if (!shouldEmitPromotionAuditLog()) return;
  console.info("[S7_PROMOTION_LIVE_PAYLOAD_AUDIT]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionFinalParityDecision(payload = {}) {
  if (!shouldEmitPromotionAuditLog()) return;
  console.info("[S7_PROMOTION_FINAL_PARITY_DECISION]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionStalePayloadBlocked(payload = {}) {
  if (!shouldEmitPromotionAuditLog()) return;
  console.info("[S7_PROMOTION_STALE_PAYLOAD_BLOCKED]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionModalOpenFreshnessCheck(payload = {}) {
  if (!shouldEmitPromotionAuditLog()) return;
  console.info("[S7_PROMOTION_MODAL_OPEN_FRESHNESS_CHECK]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionCacheBypassOnModalOpen(payload = {}) {
  if (!shouldEmitPromotionAuditLog()) return;
  console.info("[S7_PROMOTION_CACHE_BYPASS_ON_MODAL_OPEN]", payload);
}

/** @param {Record<string, unknown>} payload — nunca logar tokens ou dados sensíveis */
export function logS7PromotionDebugParity(payload = {}) {
  if (!isS7PromotionDebugEnabled()) return;
  console.info("[S7_PROMOTION_DEBUG]", payload);
}

/**
 * @param {{
 *   listingId?: string | null;
 *   promotionId?: string | null;
 *   promotionName?: string | null;
 *   cardContract?: Record<string, unknown> | null;
 *   payloadMeta?: Record<string, unknown> | null;
 *   panelAudit?: Record<string, unknown> | null;
 * }} ctx
 */
export function emitPromotionFinalParityDecisionLogs(ctx = {}) {
  const card = ctx.cardContract ?? {};
  const meta = ctx.payloadMeta ?? {};
  const panel = ctx.panelAudit ?? {};

  logS7PromotionLivePayloadAudit({
    listing_id: ctx.listingId ?? null,
    promotion_id: ctx.promotionId ?? null,
    promotion_name: ctx.promotionName ?? null,
    payload_live_received_at: meta.payload_live_received_at ?? null,
    promotion_payload_source: meta.promotion_payload_source ?? null,
    promotion_payload_age_ms: meta.promotion_payload_age_ms ?? null,
    promotion_payload_signature: meta.promotion_payload_signature ?? null,
    promotion_payload_stale_blocked: meta.promotion_payload_stale_blocked === true,
  });

  logS7PromotionFinalParityDecision({
    listing_id: ctx.listingId ?? null,
    promotion_id: ctx.promotionId ?? null,
    promotion_name: ctx.promotionName ?? null,
    selected_final_price: card.selected_final_price ?? card.real_promotion_final_price_brl ?? null,
    selected_discount_amount: card.selected_discount_amount ?? card.discount_amount_brl ?? null,
    selected_discount_percent: card.selected_discount_percent ?? card.discount_percent_display ?? null,
    selected_rule: card.selected_rule ?? null,
    selected_source: card.selected_source ?? card.selected_source_path ?? card.final_price_source ?? null,
    raw_final_price_from_ml: card.raw_final_price_from_ml ?? null,
    warning_codes: card.warning_codes ?? [],
    source_trace: card.source_trace ?? [],
    promotion_payload_source: meta.promotion_payload_source ?? null,
    panel_parity: panel,
  });

  if (meta.promotion_payload_stale_blocked === true) {
    logS7PromotionStalePayloadBlocked({
      listing_id: ctx.listingId ?? null,
      promotion_id: ctx.promotionId ?? null,
      promotion_name: ctx.promotionName ?? null,
      promotion_payload_age_ms: meta.promotion_payload_age_ms ?? null,
      promotion_payload_signature: meta.promotion_payload_signature ?? null,
    });
  }
}
