// ======================================================================
// Adapter ML — normalização de status, estoque e cadastro para saúde de anúncios.
// Preparado para Strategy/Adapter multi-marketplace (V1: Mercado Livre).
// ======================================================================

import { ATTENTION_REASON_SKU_PENDING_ML } from "../../../../handlers/ml/_helpers/mlItemSkuExtract.js";

/**
 * @param {unknown} rawStatus
 * @returns {"active" | "paused" | "inactive" | "unknown"}
 */
export function normalizeMercadoLivreListingStatus(rawStatus) {
  const s = String(rawStatus ?? "")
    .trim()
    .toLowerCase();
  if (s === "active") return "active";
  if (s === "paused") return "paused";
  if (s === "closed" || s === "inactive" || s === "not_yet_active") return "inactive";
  if (!s) return "unknown";
  return "unknown";
}

/**
 * @param {unknown} healthRow
 * @returns {number | null}
 */
function extractObjectivesCountFromHealth(healthRow) {
  const raw = healthRow?.raw_json;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const direct =
    o.suse7_quality_objectives_count ??
    o.objectives_count ??
    o.pending_goals_count ??
    o.pending_objectives_count;
  if (direct != null && Number.isFinite(Number(direct))) {
    return Math.max(0, Math.trunc(Number(direct)));
  }
  const goals = o.goals ?? o.objectives ?? o.pending_goals;
  if (Array.isArray(goals)) return goals.length;
  return null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toIntOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toScorePercent(value) {
  const n = toIntOrNull(value);
  if (n == null) return null;
  if (n > 0 && n <= 1) return Math.max(0, Math.min(100, Math.round(n * 100)));
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Normaliza linha da grid + health + métricas financeiras em snapshot único.
 *
 * @param {{
 *   listingRow?: Record<string, unknown> | null;
 *   gridRow: Record<string, unknown>;
 *   healthRow?: Record<string, unknown> | null;
 *   financialMetric?: Record<string, unknown> | null;
 * }} input
 */
export function normalizeMercadoLivreListingHealthSnapshot(input) {
  const grid = input.gridRow ?? {};
  const listing = input.listingRow ?? {};
  const health = input.healthRow ?? null;
  const fin = input.financialMetric ?? null;

  const statusNormalized = normalizeMercadoLivreListingStatus(grid.status ?? listing.status);
  const healthScore =
    toScorePercent(grid.health_percent) ??
    toScorePercent(listing.health) ??
    toScorePercent(grid.product_completeness_score) ??
    toScorePercent(grid.health_listing_quality_score);

  const missingFields = Array.isArray(grid.missing_fields)
    ? /** @type {string[]} */ (grid.missing_fields)
    : [];
  const objectivesFromHealth = health ? extractObjectivesCountFromHealth(health) : null;
  const pendingGoalsCount =
    objectivesFromHealth ??
    (missingFields.length > 0 ? missingFields.length : healthScore != null && healthScore < 100 ? 1 : 0);

  const availableQuantity = toIntOrNull(grid.available_quantity ?? listing.available_quantity);
  const picturesCount = toIntOrNull(grid.pictures_count ?? listing.pictures_count);

  const salesCount = toIntOrNull(
    fin?.quantity_sold ?? grid.qty_sold_total ?? grid.sold_quantity ?? grid.sales_count,
  );
  const grossRevenueBrl =
    fin?.gross_sales_brl != null
      ? String(fin.gross_sales_brl)
      : grid.gross_sales_brl != null
        ? String(grid.gross_sales_brl)
        : grid.gross_revenue_brl != null
          ? String(grid.gross_revenue_brl)
          : null;
  const profitBrl =
    fin?.contribution_profit_brl != null
      ? String(fin.contribution_profit_brl)
      : grid.contribution_profit_brl != null
        ? String(grid.contribution_profit_brl)
        : grid.net_profit_brl != null
          ? String(grid.net_profit_brl)
          : null;
  const profitMarginPercent =
    fin?.contribution_margin_percent != null
      ? String(fin.contribution_margin_percent)
      : grid.contribution_margin_percent != null
        ? String(grid.contribution_margin_percent)
        : null;
  const netReceivedBrl =
    fin?.net_received_brl != null
      ? String(fin.net_received_brl)
      : grid.you_receive_brl != null
        ? String(grid.you_receive_brl)
        : grid.net_received_brl != null
          ? String(grid.net_received_brl)
          : null;

  const accountName =
    grid.account_alias != null && String(grid.account_alias).trim() !== ""
      ? String(grid.account_alias).trim()
      : grid.ml_account_alias != null && String(grid.ml_account_alias).trim() !== ""
        ? String(grid.ml_account_alias).trim()
        : null;

  return {
    listing_id: grid.id != null ? String(grid.id) : listing.id != null ? String(listing.id) : "",
    product_id: grid.product_id != null ? String(grid.product_id) : listing.product_id != null ? String(listing.product_id) : null,
    external_listing_id:
      grid.external_listing_id != null
        ? String(grid.external_listing_id)
        : listing.external_listing_id != null
          ? String(listing.external_listing_id)
          : "",
    title: grid.title != null ? String(grid.title) : listing.title != null ? String(listing.title) : "",
    sku: grid.sku != null && String(grid.sku).trim() !== "" ? String(grid.sku).trim() : null,
    thumbnail_url:
      grid.cover_thumbnail_url != null && String(grid.cover_thumbnail_url).trim() !== ""
        ? String(grid.cover_thumbnail_url).trim()
        : grid.cover_image_url != null && String(grid.cover_image_url).trim() !== ""
          ? String(grid.cover_image_url).trim()
          : null,
    account_name: accountName,
    marketplace_account_id:
      grid.marketplace_account_id != null ? String(grid.marketplace_account_id) : listing.marketplace_account_id != null ? String(listing.marketplace_account_id) : null,
    marketplace: "mercadolivre",
    marketplace_raw: grid.marketplace != null ? String(grid.marketplace) : listing.marketplace != null ? String(listing.marketplace) : "mercado_livre",
    status: grid.status != null ? String(grid.status) : listing.status != null ? String(listing.status) : null,
    status_normalized: statusNormalized,
    health_score: healthScore,
    listing_quality_score: healthScore,
    pending_goals_count: pendingGoalsCount,
    missing_fields: missingFields,
    pictures_count: picturesCount,
    is_product_ready: grid.is_product_ready === true,
    needs_attention_flag: grid.needs_attention === true,
    sku_pending: grid.sku_pending === true || grid.attention_reason === ATTENTION_REASON_SKU_PENDING_ML,
    available_quantity: availableQuantity,
    sales_count: salesCount ?? 0,
    gross_revenue_brl: grossRevenueBrl,
    net_received_brl: netReceivedBrl,
    profit_brl: profitBrl,
    profit_margin_percent: profitMarginPercent,
  };
}
