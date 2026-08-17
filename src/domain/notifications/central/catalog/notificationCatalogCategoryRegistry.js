// =============================================================================
// S7 — Catálogo (S5.11) — registro de categorias oficiais
// Reutiliza S7_NOTIFICATION_CATEGORY + tabela s7_notification_categories.
// =============================================================================

import { S7_NOTIFICATION_CATEGORY, isValidNotificationCategory } from "../constants/categories.js";
import { S7_NOTIFICATION_CATALOG_DOMAIN_GROUP } from "./notificationCatalogContract.js";

/**
 * Mapeamento categoria oficial → grupo de domínio (taxonomia futura).
 * @type {Readonly<Record<string, string>>}
 */
export const S7_CATALOG_CATEGORY_DOMAIN_MAP = Object.freeze({
  [S7_NOTIFICATION_CATEGORY.BILLING]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.FINANCEIRO,
  [S7_NOTIFICATION_CATEGORY.PROFIT]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.FINANCEIRO,
  [S7_NOTIFICATION_CATEGORY.MARKETPLACE]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.MARKETPLACE,
  [S7_NOTIFICATION_CATEGORY.ACCOUNT_HEALTH]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.SEGURANCA,
  [S7_NOTIFICATION_CATEGORY.SYNC]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.OPERACIONAL,
  [S7_NOTIFICATION_CATEGORY.SYSTEM]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.SISTEMA,
  [S7_NOTIFICATION_CATEGORY.DEVCENTER]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.SISTEMA,
  [S7_NOTIFICATION_CATEGORY.SALES]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.COMERCIAL,
  [S7_NOTIFICATION_CATEGORY.COMPETITION]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.COMERCIAL,
  [S7_NOTIFICATION_CATEGORY.PRODUCTS]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.OPERACIONAL,
  [S7_NOTIFICATION_CATEGORY.INVENTORY]: S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.OPERACIONAL,
});

/**
 * @returns {Array<{ code: string; domain_group: string }>}
 */
export function listCatalogSupportedCategories() {
  return Object.values(S7_NOTIFICATION_CATEGORY).map((code) => ({
    code,
    domain_group: S7_CATALOG_CATEGORY_DOMAIN_MAP[code] ?? S7_NOTIFICATION_CATALOG_DOMAIN_GROUP.OPERACIONAL,
  }));
}

/**
 * @param {string} code
 */
export function getCatalogCategoryMeta(code) {
  const c = String(code ?? "").trim();
  if (!isValidNotificationCategory(c)) return null;
  return {
    code: c,
    domain_group: S7_CATALOG_CATEGORY_DOMAIN_MAP[c] ?? null,
    table: "s7_notification_categories",
  };
}
