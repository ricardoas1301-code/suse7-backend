// ======================================================================
// Registro de rotas operacionais — fail-closed (S1.HF.6.9)
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_ACCESS_PROFILE,
  BILLING_ENTITLEMENT_CAPABILITY,
  BILLING_ENTITLEMENT_ERROR_CODE,
} from "../billingConstants.js";
import { BILLING_GATE_CAPABILITY_BY_SCOPE, isKnownEntitlementScope } from "./billingEntitlementScopeMap.js";

/** Prefixos operacionais sujeitos a classificação obrigatória. */
export const BILLING_OPERATIONAL_NAMESPACE_PREFIXES = [
  "/api/sales",
  "/api/pricing",
  "/api/ml/listings",
  "/api/products",
  "/api/competition",
  "/api/dashboard/listings-health-summary",
  "/api/dashboard/pricing-health-summary",
  "/api/dashboard/products-health-summary",
  "/api/dashboard/competition-health-summary",
  "/api/listings/bulk-set-sku",
];

/** Prefixos isentos de classificação operacional. */
export const BILLING_ENTITLEMENT_EXEMPT_PREFIXES = [
  "/api/billing",
  "/api/auth",
  "/api/public",
  "/api/user/",
  "/api/seller/companies",
  "/api/marketplace/accounts",
  "/api/dev-center",
  "/api/internal",
  "/api/notifications",
  "/api/customers",
];

/**
 * @typedef {{
 *   endpoint: string;
 *   method: string;
 *   module: string;
 *   category: string;
 *   scope: string;
 *   capability: string;
 *   profiles: { FULL: boolean; EXECUTIVE: boolean; ARCHIVE: boolean; FINANCIAL: boolean };
 * }} BillingEndpointInventoryRow
 */

/** @param {string} endpoint @param {string} method @param {string} module @param {string} category @param {string} scope @param {{ FULL?: boolean; EXECUTIVE?: boolean; ARCHIVE?: boolean; FINANCIAL?: boolean }} [profiles] */
function row(endpoint, method, module, category, scope, profiles = {}) {
  const capability = BILLING_GATE_CAPABILITY_BY_SCOPE[scope] ?? scope;
  return {
    endpoint,
    method: method.toUpperCase(),
    module,
    category,
    scope,
    capability,
    profiles: {
      FULL: profiles.FULL !== false,
      EXECUTIVE: Boolean(profiles.EXECUTIVE),
      ARCHIVE: Boolean(profiles.ARCHIVE),
      FINANCIAL: Boolean(profiles.FINANCIAL),
    },
  };
}

/** @type {BillingEndpointInventoryRow[]} */
export const BILLING_ENTITLEMENT_ENDPOINT_INVENTORY = [
  // —— Vendas ——
  row("/api/sales/executive-summary", "GET", "vendas", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),
  row("/api/sales/top10", "GET", "vendas", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),
  row("/api/sales", "GET", "vendas", "list", "sales_list", { ARCHIVE: true }),
  row("/api/sales/detail", "GET", "vendas", "detail", "sales_detail", { ARCHIVE: true }),
  row("/api/sales/import-ml-report", "POST", "vendas", "export", "exports"),

  // —— Anúncios / ML listings ——
  row("/api/ml/listings", "GET", "anuncios", "list", "listings_list", { ARCHIVE: true }),
  row("/api/ml/listings/detail", "GET", "anuncios", "detail", "sales_detail", { ARCHIVE: true }),
  row("/api/ml/listings/accumulated-performance", "GET", "anuncios", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),
  row("/api/ml/listings/catalog-pricing-health-buckets", "GET", "anuncios", "aux", "pricing_list", { ARCHIVE: true }),
  row("/api/ml/listings/sku-pending", "GET", "anuncios", "aux", "listings_list", { ARCHIVE: true }),
  row("/api/ml/listings/seller-promotions-grid", "GET", "anuncios", "detail", "sales_detail", { ARCHIVE: true }),
  row("/api/ml/listings/sku-lookup", "GET", "anuncios", "aux", "filters_search", { ARCHIVE: true }),
  row("/api/ml/listings/set-sku", "POST", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/content", "PATCH", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/stock-settings", "PATCH", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/description-settings", "PATCH", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/measurement-settings", "PATCH", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/primary-picture-settings", "PATCH", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/pricing-scenarios", "POST", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/pricing-simulate-scenario", "POST", "anuncios", "write", "marketplace_ops"),
  row("/api/ml/listings/pricing-simulation-config", "GET", "precificacoes", "aux", "sales_detail", { ARCHIVE: true }),
  row("/api/ml/listings/pricing-simulation-config", "POST", "precificacoes", "write", "marketplace_ops"),
  row("/api/dashboard/listings-health-summary", "GET", "anuncios", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),

  // —— Precificações ——
  row("/api/pricing/simulate", "POST", "precificacoes", "write", "marketplace_ops"),
  row("/api/pricing/apply", "POST", "precificacoes", "write", "marketplace_ops"),
  row("/api/pricing/intelligent/:id/financial-settings", "PATCH", "precificacoes", "write", "marketplace_ops"),
  row("/api/dashboard/pricing-health-summary", "GET", "precificacoes", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),

  // —— Produtos ——
  row("/api/products/catalog-financial", "GET", "produtos", "list", "pricing_list", { ARCHIVE: true }),
  row("/api/products/catalog-health-buckets", "GET", "produtos", "aux", "pricing_list", { ARCHIVE: true }),
  row("/api/products/catalog-rankings", "GET", "produtos", "aux", "pricing_list", { ARCHIVE: true }),
  row("/api/products/health", "GET", "produtos", "aux", "pricing_list", { ARCHIVE: true }),
  row("/api/products/listings", "GET", "produtos", "aux", "pricing_list", { ARCHIVE: true }),
  row("/api/products/for-edit", "GET", "produtos", "detail", "sales_detail", { ARCHIVE: true }),
  row("/api/products/ad-titles", "GET", "produtos", "aux", "filters_search", { ARCHIVE: true }),
  row("/api/products/costs/pending", "GET", "produtos", "aux", "pricing_list", { ARCHIVE: true }),
  row("/api/products/upsert", "POST", "produtos", "write", "marketplace_ops"),
  row("/api/products/change-status", "POST", "produtos", "write", "marketplace_ops"),
  row("/api/products/costs/batch", "POST", "produtos", "write", "marketplace_ops"),
  row("/api/products/:id", "PATCH", "produtos", "write", "marketplace_ops"),
  row("/api/dashboard/products-health-summary", "GET", "produtos", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),
  row("/api/listings/bulk-set-sku", "POST", "anuncios", "write", "marketplace_ops"),

  // —— Concorrência ——
  row("/api/competition/monitored-listings", "GET", "concorrencia", "list", "listings_list", { ARCHIVE: true }),
  row("/api/competition/monitored-listings", "POST", "concorrencia", "write", "marketplace_ops"),
  row("/api/competition/monitored-listings/:id", "DELETE", "concorrencia", "write", "marketplace_ops"),
  row("/api/competition/monitored-listings/:id/competitors", "GET", "concorrencia", "detail", "sales_detail", { ARCHIVE: true }),
  row("/api/competition/listings/search", "GET", "concorrencia", "aux", "filters_search", { ARCHIVE: true }),
  row("/api/competition/products", "GET", "concorrencia", "aux", "filters_search", { ARCHIVE: true }),
  row("/api/competition/products/:id/competitors", "GET", "concorrencia", "detail", "sales_detail", { ARCHIVE: true }),
  row("/api/competition/products/:id/competitors", "POST", "concorrencia", "write", "marketplace_ops"),
  row("/api/competition/products/:id/discover", "POST", "concorrencia", "write", "marketplace_ops"),
  row("/api/competition/products/:id/resolve-link", "POST", "concorrencia", "write", "marketplace_ops"),
  row("/api/competition/products/:id/snapshot", "POST", "concorrencia", "write", "marketplace_ops"),
  row("/api/competition/competitors/:id", "DELETE", "concorrencia", "write", "marketplace_ops"),
  row("/api/dashboard/competition-health-summary", "GET", "concorrencia", "executive", "executive_cards", { EXECUTIVE: true, ARCHIVE: true }),
];

/**
 * @param {string} path
 */
export function normalizeOperationalRoutePath(path) {
  const raw = String(path ?? "").split("?")[0].trim();
  if (!raw.startsWith("/api/")) return raw;
  return raw
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/MLB[0-9]+/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/**
 * @param {string} path
 */
export function isOperationalNamespacePath(path) {
  const normalized = normalizeOperationalRoutePath(path);
  if (BILLING_ENTITLEMENT_EXEMPT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }
  return BILLING_OPERATIONAL_NAMESPACE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * @param {string} template
 * @param {string} path
 */
function routeTemplateMatches(template, path) {
  const tParts = template.split("/").filter(Boolean);
  const pParts = path.split("/").filter(Boolean);
  if (tParts.length !== pParts.length) return false;
  for (let i = 0; i < tParts.length; i += 1) {
    if (tParts[i].startsWith(":")) continue;
    if (tParts[i] !== pParts[i]) return false;
  }
  return true;
}

/**
 * @param {string} path
 * @param {string} method
 */
export function resolveRouteEntitlementClassification(path, method) {
  const normalized = normalizeOperationalRoutePath(path);
  const verb = String(method ?? "GET").toUpperCase();
  const match = BILLING_ENTITLEMENT_ENDPOINT_INVENTORY.find(
    (entry) => entry.method === verb && routeTemplateMatches(entry.endpoint, normalized)
  );
  if (match) {
    return { classified: true, operational: true, scope: match.scope, inventory: match };
  }
  if (isOperationalNamespacePath(normalized)) {
    return { classified: false, operational: true, scope: null, inventory: null };
  }
  return { classified: false, operational: false, scope: null, inventory: null };
}

/**
 * @param {string} scope
 * @param {string | null | undefined} accessProfile
 */
export function resolveScopeCapabilityOrFail(scope, accessProfile) {
  if (isKnownEntitlementScope(scope)) {
    return BILLING_GATE_CAPABILITY_BY_SCOPE[scope];
  }
  if (accessProfile === BILLING_ACCESS_PROFILE.FULL_ACCESS) {
    return scope;
  }
  const error = new Error(BILLING_ENTITLEMENT_ERROR_CODE.BILLING_CAPABILITY_CLASSIFICATION_REQUIRED);
  error.code = BILLING_ENTITLEMENT_ERROR_CODE.BILLING_CAPABILITY_CLASSIFICATION_REQUIRED;
  error.status = 403;
  error.scope = scope;
  throw error;
}

/**
 * @param {string} path
 * @param {string} method
 * @param {string | null | undefined} accessProfile
 */
export function assertOperationalRouteClassification(path, method, accessProfile) {
  const classification = resolveRouteEntitlementClassification(path, method);
  if (!classification.operational) return classification;
  if (accessProfile === BILLING_ACCESS_PROFILE.FULL_ACCESS) return classification;
  if (!classification.classified) {
    if (process.env.NODE_ENV !== "production") {
      logBilling("billing", "BILLING_ROUTE_CLASSIFICATION_MISSING", {
        path: normalizeOperationalRoutePath(path),
        method: String(method ?? "GET").toUpperCase(),
        access_profile: accessProfile,
      });
    }
    const error = new Error(BILLING_ENTITLEMENT_ERROR_CODE.BILLING_CAPABILITY_CLASSIFICATION_REQUIRED);
    error.code = BILLING_ENTITLEMENT_ERROR_CODE.BILLING_CAPABILITY_CLASSIFICATION_REQUIRED;
    error.status = 403;
    error.path = normalizeOperationalRoutePath(path);
    error.method = method;
    throw error;
  }
  return classification;
}

/**
 * @param {string} moduleName
 */
export function listBillingEndpointInventoryByModule(moduleName) {
  return BILLING_ENTITLEMENT_ENDPOINT_INVENTORY.filter((entry) => entry.module === moduleName);
}

/**
 * @param {string[]} modules
 */
export function assertOperationalModulesFullyClassified(modules = ["vendas", "precificacoes", "anuncios", "produtos", "concorrencia"]) {
  /** @type {string[]} */
  const missing = [];
  for (const moduleName of modules) {
    const rows = listBillingEndpointInventoryByModule(moduleName);
    if (rows.length === 0) missing.push(`${moduleName}:empty_inventory`);
  }
  return { ok: missing.length === 0, missing, total: BILLING_ENTITLEMENT_ENDPOINT_INVENTORY.length };
}
