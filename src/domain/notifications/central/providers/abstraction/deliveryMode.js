// =============================================================================
// Modos de entrega — Fase 3.5C (mock | sandbox | live)
// =============================================================================

/** @typedef {'mock' | 'sandbox' | 'live'} DeliveryMode */

export const S7_DELIVERY_MODE = Object.freeze({
  MOCK: /** @type {DeliveryMode} */ ("mock"),
  SANDBOX: /** @type {DeliveryMode} */ ("sandbox"),
  LIVE: /** @type {DeliveryMode} */ ("live"),
});

/**
 * @param {string | null | undefined} raw
 * @returns {DeliveryMode | null}
 */
export function parseDeliveryMode(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "mock" || v === "simulate" || v === "simulated") return S7_DELIVERY_MODE.MOCK;
  if (v === "sandbox" || v === "dev_sandbox") return S7_DELIVERY_MODE.SANDBOX;
  if (v === "live" || v === "production" || v === "live_controlled") return S7_DELIVERY_MODE.LIVE;
  return null;
}
