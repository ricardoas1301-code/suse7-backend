// ============================================================
// S7 — Concorrência: diff de snapshot (rotina diária automática)
// Cria histórico apenas quando há alteração relevante.
// ============================================================

function normalizePrice(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

function normalizeText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function normalizeSalesHint(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
}

function stableShipping(shipping) {
  if (!shipping || typeof shipping !== "object") return null;
  return JSON.stringify({
    free_shipping: shipping.free_shipping === true,
    mode: shipping.mode != null ? String(shipping.mode) : null,
    logistic_type: shipping.logistic_type != null ? String(shipping.logistic_type) : null,
  });
}

function stableReputation(reputation) {
  if (!reputation || typeof reputation !== "object") return null;
  return JSON.stringify({
    level_id: reputation.level_id != null ? String(reputation.level_id) : null,
    power_seller_status:
      reputation.power_seller_status != null ? String(reputation.power_seller_status) : null,
    transactions_completed:
      reputation.transactions_completed != null ? String(reputation.transactions_completed) : null,
  });
}

/**
 * Extrai status do anúncio ML (active, paused, closed, …).
 * @param {Record<string, unknown> | null | undefined} enrichedRaw
 */
export function extractListingStatus(enrichedRaw) {
  if (!enrichedRaw || typeof enrichedRaw !== "object") return null;
  const direct = enrichedRaw.status ?? enrichedRaw.listing_status;
  if (direct != null && String(direct).trim() !== "") {
    return String(direct).trim().toLowerCase();
  }
  return null;
}

/**
 * Monta baseline comparável a partir do último snapshot + registro vivo.
 * @param {{
 *   competitor?: Record<string, unknown> | null;
 *   latestSnapshot?: Record<string, unknown> | null;
 * }} input
 */
export function buildSnapshotComparableBaseline({ competitor, latestSnapshot }) {
  const comp = competitor && typeof competitor === "object" ? competitor : {};
  const snap = latestSnapshot && typeof latestSnapshot === "object" ? latestSnapshot : null;
  const raw =
    snap?.raw_snapshot && typeof snap.raw_snapshot === "object" ? snap.raw_snapshot : {};

  return {
    price: normalizePrice(snap?.competitor_price ?? comp.last_seen_price ?? null),
    shipping: stableShipping(snap?.shipping ?? null),
    listing_type: normalizeText(snap?.listing_type ?? null),
    reputation: stableReputation(snap?.reputation ?? null),
    sales_hint: normalizeSalesHint(snap?.sales_hint ?? null),
    competitor_thumbnail: normalizeText(snap?.competitor_thumbnail ?? comp.competitor_thumbnail ?? null),
    competitor_permalink: normalizeText(snap?.competitor_permalink ?? comp.competitor_permalink ?? null),
    category_id: normalizeText(raw.category_id ?? null),
    category_path: normalizeText(raw.category_path ?? null),
    listing_status: normalizeText(
      raw.listing_status ?? comp.competitor_listing_status ?? null
    ),
  };
}

/**
 * Monta candidato comparável após enrich da rotina diária.
 * @param {{
 *   normalized?: Record<string, unknown> | null;
 *   enrichExtras?: Record<string, unknown> | null;
 *   enrichedRaw?: Record<string, unknown> | null;
 * }} input
 */
export function buildSnapshotComparableCandidate({ normalized, enrichExtras, enrichedRaw }) {
  const norm = normalized && typeof normalized === "object" ? normalized : {};
  const extras = enrichExtras && typeof enrichExtras === "object" ? enrichExtras : {};
  const raw = enrichedRaw && typeof enrichedRaw === "object" ? enrichedRaw : {};

  return {
    price: normalizePrice(norm.last_seen_price ?? raw.competitor_price ?? null),
    shipping: stableShipping(extras.shipping ?? raw.shipping ?? null),
    listing_type: normalizeText(extras.listing_type ?? raw.listing_type ?? null),
    reputation: stableReputation(extras.reputation ?? raw.reputation ?? null),
    sales_hint: normalizeSalesHint(extras.sales_hint ?? raw.sales_hint ?? null),
    competitor_thumbnail: normalizeText(norm.competitor_thumbnail ?? raw.competitor_thumbnail ?? null),
    competitor_permalink: normalizeText(norm.competitor_permalink ?? raw.competitor_permalink ?? null),
    category_id: normalizeText(raw.category_id ?? extras.category_id ?? null),
    category_path: normalizeText(raw.category_path ?? extras.category_path ?? null),
    listing_status:
      extractListingStatus(raw) ?? normalizeText(norm.competitor_listing_status ?? null),
  };
}

/**
 * @param {ReturnType<typeof buildSnapshotComparableBaseline> | null | undefined} before
 * @param {ReturnType<typeof buildSnapshotComparableCandidate>} after
 * @returns {{ changed: boolean; changed_fields: string[] }}
 */
export function detectRelevantSnapshotChanges(before, after) {
  if (!before) {
    return { changed: true, changed_fields: ["initial_baseline"] };
  }

  const fields = [
    "price",
    "shipping",
    "listing_type",
    "reputation",
    "sales_hint",
    "competitor_thumbnail",
    "competitor_permalink",
    "category_id",
    "category_path",
    "listing_status",
  ];

  const changedFields = [];
  for (const field of fields) {
    const prev = before[field] ?? null;
    const next = after[field] ?? null;
    if (prev !== next) changedFields.push(field);
  }

  return { changed: changedFields.length > 0, changed_fields: changedFields };
}
