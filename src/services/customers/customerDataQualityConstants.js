// =============================================================================
// Clientes 360 — data quality (Fase 4A.3)
// =============================================================================

import { config } from "../../infra/config.js";

export const DATA_QUALITY_STATUS = {
  GOOD: "good",
  FAIR: "fair",
  POOR: "poor",
  UNKNOWN: "unknown",
};

export const CONFIDENCE_GOOD_PCT = 85;
export const CONFIDENCE_FAIR_PCT = 65;

export const DIMENSION_WEIGHTS = {
  contact: 0.35,
  address: 0.25,
  identity: 0.25,
  recency: 0.15,
};

export const RECENCY_FRESH_DAYS = 30;
export const RECENCY_COMPARE_TOLERANCE_MS = 60 * 1000;
export const MAX_SAMPLE_ISSUES = 5;

export function isCustomersDataQualityEnabled() {
  return config.customersDataQualityEnabled === true;
}
