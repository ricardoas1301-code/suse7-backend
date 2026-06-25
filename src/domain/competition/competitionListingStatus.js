// ============================================================
// S7 — Concorrência: status oficial do anúncio ML
// ============================================================

export const ML_LISTING_STATUS_ACTIVE = "active";

/** Status que devem exibir badge INATIVO na UI (contrato oficial ML). */
export const ML_LISTING_STATUS_INATIVO = new Set([
  "paused",
  "closed",
  "inactive",
  "not_found",
  "under_review",
  "forbidden",
  "unavailable",
]);

/** Status inferidos só por falha HTTP — não devem persistir se o enrich trouxe dados vivos. */
export const ML_LISTING_STATUS_INFERIDO_POR_HTTP = new Set(["not_found", "unavailable"]);

/**
 * Evidência de anúncio ainda comercializável no enrich (catálogo / fallback parcial).
 * @param {Record<string, unknown> | null | undefined} enrichedRaw
 */
export function hasEnrichLiveSignals(enrichedRaw) {
  if (!enrichedRaw || typeof enrichedRaw !== "object") return false;
  if (enrichedRaw.competitor_price != null && String(enrichedRaw.competitor_price).trim() !== "") {
    return true;
  }
  if (enrichedRaw.competitor_title != null && String(enrichedRaw.competitor_title).trim() !== "") {
    return true;
  }
  if (
    enrichedRaw.competitor_thumbnail != null &&
    String(enrichedRaw.competitor_thumbnail).trim() !== ""
  ) {
    return true;
  }
  const sold = Number(enrichedRaw.sales_hint ?? enrichedRaw.sold_quantity);
  if (Number.isFinite(sold) && sold > 0) return true;
  return false;
}

function enrichDebugHttpStatuses(enrichDebug) {
  const attempts = Array.isArray(enrichDebug?.attempts) ? enrichDebug.attempts : [];
  return attempts
    .map((a) => (a?.status != null ? Number(a.status) : null))
    .filter((n) => Number.isFinite(n));
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 */
export function hasPersistedLiveCommercialData(row) {
  if (!row || typeof row !== "object") return false;
  if (row.last_seen_price != null && String(row.last_seen_price).trim() !== "") return true;
  if (row.competitor_thumbnail != null && String(row.competitor_thumbnail).trim() !== "") return true;
  if (row.competitor_title != null && String(row.competitor_title).trim() !== "") return true;
  return false;
}

const ROTULOS_OFICIAIS_PT = {
  active: "Ativo",
  paused: "Pausado",
  closed: "Encerrado",
  inactive: "Inativo",
  under_review: "Em revisão",
  forbidden: "Indisponível",
  not_found: "Indisponível",
};

/**
 * Normaliza status vindo da API ML (sem inventar valores).
 * @param {unknown} value
 * @param {{ httpStatus?: number | null }} [opts]
 * @returns {string | null}
 */
export function normalizeMercadoLivreListingStatus(value, opts = {}) {
  const httpStatus = opts.httpStatus != null ? Number(opts.httpStatus) : null;
  if (httpStatus === 404) return "not_found";

  if (value == null || String(value).trim() === "") return null;

  const s = String(value).trim().toLowerCase();
  if (ROTULOS_OFICIAIS_PT[s]) return s;
  if (/^[a-z][a-z0-9_]*$/.test(s)) return s;
  return null;
}

/**
 * @param {string | null | undefined} status
 */
export function isMercadoLivreListingActive(status) {
  const s = normalizeMercadoLivreListingStatus(status);
  if (!s) return true;
  if (s === ML_LISTING_STATUS_ACTIVE) return true;
  if (ML_LISTING_STATUS_INATIVO.has(s)) return false;
  return true;
}

/**
 * Rótulo amigável em PT-BR para UI (baseado no status oficial).
 * @param {string | null | undefined} status
 */
export function rotuloStatusAnuncioMl(status) {
  const s = normalizeMercadoLivreListingStatus(status);
  if (!s) return null;
  if (ROTULOS_OFICIAIS_PT[s]) return ROTULOS_OFICIAIS_PT[s];
  return s.replace(/_/g, " ");
}

/**
 * Resolve status a partir do enrich (body ML ou HTTP 404).
 * @param {Record<string, unknown> | null | undefined} enrichedRaw
 * @param {{ attempts?: { status?: number | null }[] } | null | undefined} enrichDebug
 */
export function resolveCompetitorListingStatusFromEnrich(enrichedRaw, enrichDebug = null) {
  const fromBody = normalizeMercadoLivreListingStatus(
    enrichedRaw?.status ?? enrichedRaw?.listing_status
  );
  if (fromBody) return fromBody;

  // Fallback catálogo / enrich parcial: GET /items pode retornar 404 mesmo com anúncio ativo.
  if (hasEnrichLiveSignals(enrichedRaw)) return null;

  const httpStatuses = enrichDebugHttpStatuses(enrichDebug);
  if (httpStatuses.includes(404)) return "not_found";
  return null;
}

/**
 * Atualização de status para persistência.
 * @returns {{ mode: "set"; status: string } | { mode: "clear" } | { mode: "noop" }}
 */
export function resolveListingStatusPersistUpdate(enrichedRaw, enrichDebug = null) {
  const resolved = resolveCompetitorListingStatusFromEnrich(enrichedRaw, enrichDebug);
  if (resolved) return { mode: "set", status: resolved };
  if (enrichedRaw && hasEnrichLiveSignals(enrichedRaw)) return { mode: "clear" };
  return { mode: "noop" };
}

function sanitizeFalseInactiveListingStatus(status, input = {}) {
  const normalized = normalizeMercadoLivreListingStatus(status);
  if (!normalized || !ML_LISTING_STATUS_INFERIDO_POR_HTTP.has(normalized)) return normalized;
  if (hasPersistedLiveCommercialData(input)) return null;
  return normalized;
}

/**
 * Campos de contrato API para o frontend.
 * @param {{
 *   rowStatus?: string | null;
 *   snapshotStatus?: string | null;
 * }} input
 */
export function annotateCompetitorListingStatus(input = {}) {
  const status = sanitizeFalseInactiveListingStatus(
    normalizeMercadoLivreListingStatus(input.rowStatus) ??
      normalizeMercadoLivreListingStatus(input.snapshotStatus),
    input
  );

  return {
    competitor_listing_status: status,
    competitor_listing_status_label: rotuloStatusAnuncioMl(status),
    is_competitor_listing_active: isMercadoLivreListingActive(status),
  };
}
