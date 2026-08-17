// ======================================================================
// Factory de providers de billing
// ======================================================================

import { config } from "../../infra/config.js";
import { BillingProvider } from "./BillingProvider.js";
import { AsaasBillingProvider } from "./AsaasBillingProvider.js";

/**
 * @param {string} [name]
 * @returns {BillingProvider}
 */
export function getBillingProvider(name) {
  const key = (name || config.billingProviderDefault || "asaas").trim().toLowerCase();
  if (key === "asaas") {
    return new AsaasBillingProvider();
  }
  throw new Error(`Billing provider não suportado: ${key}`);
}

export { BillingProvider, AsaasBillingProvider };
