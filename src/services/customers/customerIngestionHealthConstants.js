// =============================================================================
// Clientes 360 — observabilidade de ingestão (Fase 4A.2)
// =============================================================================

import { config } from "../../infra/config.js";

export const INGESTION_HEALTH_STATUS = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  CRITICAL: "critical",
  UNKNOWN: "unknown",
};

export const COVERAGE_HEALTHY_PCT = 98;
export const COVERAGE_DEGRADED_PCT = 90;
export const STALE_DEGRADED_PCT = 2;
export const STALE_CRITICAL_PCT = 10;
export const STALE_LAG_HOURS = 24;
export const PENDING_CRITICAL_COUNT = 500;
export const MAX_ORDERS_SCAN = 10000;
export const STALE_COMPARE_TOLERANCE_MS = 60 * 1000;

export function isCustomersIngestionHealthEnabled() {
  return config.customersIngestionHealthEnabled === true;
}
