// ======================================================
// Linhas brutas de promoção persistidas — SSOT compartilhado
// (Modal PI / coluna Promoções / selector da Lista de Precificações).
// ======================================================

import { extractDbSnapshotPromotionRows } from "./mercadoLivrePromotionSsotFreshnessAudit.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
} from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import {
  mercadoLivreListingPayloadForMoneyFields,
} from "../../handlers/ml/_helpers/mercadoLivreListingMoneyShared.js";

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {Record<string, unknown>[]}
 */
export function extractPersistedPromotionRawRows(listing, health = null) {
  /** @type {Record<string, unknown>[]} */
  const rows = [...extractDbSnapshotPromotionRows(listing)];

  const healthRaw =
    health?.raw_json != null && typeof health.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (health.raw_json)
      : null;
  const payloads =
    healthRaw?.raw_payloads != null &&
    typeof healthRaw.raw_payloads === "object" &&
    !Array.isArray(healthRaw.raw_payloads)
      ? /** @type {Record<string, unknown>} */ (healthRaw.raw_payloads)
      : null;

  const sellerPromotionFromSalePrice = payloads?.seller_promotion_from_sale_price;
  if (
    sellerPromotionFromSalePrice != null &&
    typeof sellerPromotionFromSalePrice === "object" &&
    !Array.isArray(sellerPromotionFromSalePrice)
  ) {
    rows.push(/** @type {Record<string, unknown>} */ (sellerPromotionFromSalePrice));
  }

  const merged = coalesceMercadoLibreItemForMoneyExtract(
    mercadoLivreListingPayloadForMoneyFields(listing, health),
  );
  const itemPromotions = merged?._suse7_item_promotions;
  if (Array.isArray(itemPromotions)) {
    for (const row of itemPromotions) {
      if (row != null && typeof row === "object") {
        rows.push(/** @type {Record<string, unknown>} */ ({ ...row }));
      }
    }
  }

  /** Dedupe fraco por id + status + price. */
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const pid = row.id ?? row.promotion_id ?? "";
    const status = row.status ?? row.raw_status ?? "";
    const price = row.price ?? row.amount ?? row.final_price ?? "";
    const name = row.name ?? row.promotion_name ?? "";
    const key = [pid, status, price, name].map((v) => String(v ?? "").trim()).join("|");
    if (key.replace(/\|/g, "") === "") continue;
    if (!byKey.has(key)) byKey.set(key, row);
  }

  return Array.from(byKey.values());
}
