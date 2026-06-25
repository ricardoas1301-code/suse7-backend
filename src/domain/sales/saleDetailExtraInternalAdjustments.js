// ======================================================
// Ajustes internos extras (Precificação) — contrato do Raio-x da venda.
// Leitura apenas; sem cálculo de lucro nesta etapa.
// ======================================================

import Decimal from "decimal.js";
import { financialSettingsFromConfig } from "../pricing/listingFinancialSettings.js";

/**
 * @param {import("../sales/saleListingHealthCommercial.js").PricingSimulationConfig} config
 */
export function buildSaleDetailExtraInternalAdjustments(config) {
  const settings = financialSettingsFromConfig(config);
  const values = Object.values(settings);
  const hasPersisted = values.some((v) => v != null && String(v).trim() !== "" && new Decimal(String(v)).gt(0));

  return {
    promo_discount_percent: settings.promo_discount_percent,
    ml_ads_percent: settings.ml_ads_percent,
    affiliate_percent: settings.affiliate_percent,
    reserve_percent: settings.reserve_percent,
    source: "pricing_financial_settings",
    confidence: hasPersisted ? "persisted" : "missing",
  };
}
