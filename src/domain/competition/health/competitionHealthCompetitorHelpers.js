// ======================================================================
// Helpers de concorrente — Central de Saúde da Concorrência (Dashboard).
// Paridade com concorrenciaCompetitorDisplay.js / competitionListingStatus.js
// ======================================================================

import { isMercadoLivreListingActive } from "../competitionListingStatus.js";
import { isConcorrenteAtivoComparavel } from "./competitionHealthPriceHelpers.js";

const NIVEIS_REPUTACAO_VERDE = new Set(["5_green", "4_light_green"]);

/** @param {unknown} competitor */
function chaveUnicaConcorrente(competitor) {
  if (!competitor || typeof competitor !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (competitor);
  if (record.id != null && String(record.id).trim() !== "") return `id:${String(record.id).trim()}`;
  if (record.competitor_listing_id != null && String(record.competitor_listing_id).trim() !== "") {
    return `listing:${String(record.competitor_listing_id).trim()}`;
  }
  return null;
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 * @returns {Array<Record<string, unknown>>}
 */
export function flattenConcorrentesMonitorados(snapshots) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const snapshot of snapshots || []) {
    const competitors = Array.isArray(snapshot?.competitors) ? snapshot.competitors : [];
    for (const competitor of competitors) {
      if (competitor && typeof competitor === "object") {
        rows.push(/** @type {Record<string, unknown>} */ (competitor));
      }
    }
  }
  return rows;
}

/**
 * Concorrentes únicos (dedupe por id/listing_id).
 * @param {Array<Record<string, unknown>>} snapshots
 * @returns {Array<Record<string, unknown>>}
 */
export function deduplicarConcorrentesAtivosAnalisaveis(snapshots) {
  const map = new Map();
  for (const competitor of flattenConcorrentesMonitorados(snapshots)) {
    if (!isConcorrenteAtivoComparavel(competitor)) continue;
    const key = chaveUnicaConcorrente(competitor);
    if (!key || map.has(key)) continue;
    map.set(key, competitor);
  }
  return [...map.values()];
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 * @returns {Array<Record<string, unknown>>}
 */
export function listarConcorrentesInativosMonitorados(snapshots) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const competitor of flattenConcorrentesMonitorados(snapshots)) {
    if (!competitor || typeof competitor !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (competitor);
    if (record.is_active === false) continue;
    if (isConcorrenteAtivoComparavel(competitor)) continue;
    rows.push(record);
  }
  return rows;
}

/** @param {unknown} shipping */
export function isFreteGratisConcorrente(shipping) {
  if (!shipping || typeof shipping !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (shipping);
  if (record.free_shipping === true) return true;
  const cost = record.cost ?? record.shipping_cost;
  if (cost != null && String(cost).trim() !== "") {
    const n = Number(String(cost).replace(",", "."));
    return Number.isFinite(n) && n === 0;
  }
  return false;
}

/** @param {unknown} shipping */
export function isConcorrenteLogisticaFull(shipping) {
  if (!shipping || typeof shipping !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (shipping);
  const logisticType =
    record.logistic_type != null ? String(record.logistic_type).trim().toLowerCase() : "";
  return logisticType === "fulfillment";
}

/**
 * @param {unknown} competitor
 * @returns {{ known: boolean; official: boolean }}
 */
export function extrairDadoLojaOficialConcorrente(competitor) {
  if (!competitor || typeof competitor !== "object") return { known: false, official: false };
  const record = /** @type {Record<string, unknown>} */ (competitor);

  if (record.is_official_store === true) return { known: true, official: true };
  if (record.is_official_store === false) return { known: true, official: false };

  if (record.official_store_id != null && String(record.official_store_id).trim() !== "") {
    return { known: true, official: true };
  }
  if (record.official_store_name != null && String(record.official_store_name).trim() !== "") {
    return { known: true, official: true };
  }

  return { known: false, official: false };
}

/**
 * @param {unknown} reputation
 * @returns {"platinum" | "gold" | "mercado_lider" | "green_reputation" | "no_reputation"}
 */
export function resolverChaveReputacaoConcorrente(reputation) {
  const rep = reputation && typeof reputation === "object" ? /** @type {Record<string, unknown>} */ (reputation) : {};
  const powerSeller =
    rep.power_seller_status != null ? String(rep.power_seller_status).trim().toLowerCase() : "";

  if (powerSeller === "platinum") return "platinum";
  if (powerSeller === "gold") return "gold";
  if (powerSeller === "silver") return "mercado_lider";

  const levelId = rep.level_id != null ? String(rep.level_id).trim().toLowerCase() : "";
  if (levelId && NIVEIS_REPUTACAO_VERDE.has(levelId)) return "green_reputation";

  return "no_reputation";
}

/** @param {unknown} competitor */
export function isConcorrenteInativoMonitorado(competitor) {
  if (!competitor || typeof competitor !== "object") return false;
  const record = /** @type {Record<string, unknown>} */ (competitor);
  if (record.is_active === false) return false;

  if (record.is_competitor_listing_active === false) return true;

  const status =
    record.competitor_listing_status != null
      ? String(record.competitor_listing_status).trim()
      : record.listing_status != null
        ? String(record.listing_status).trim()
        : null;

  return !isMercadoLivreListingActive(status);
}
