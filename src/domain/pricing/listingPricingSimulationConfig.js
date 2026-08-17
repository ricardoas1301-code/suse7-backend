// ======================================================
// Configuração de simulação de precificação — persistência em raw_json.
// ======================================================

/** @typedef {{ enabled: boolean; percent: string | null; amount: string | null }} PricingSimVar */

/** @typedef {Record<string, PricingSimVar>} PricingSimulationConfig */

const STORAGE_KEY = "_s7_pricing_simulation";

const FIELD_ALIASES = {
  planned_promo: ["planned_promo", "promo", "discount_promo", "desc_promo"],
  ml_ads: ["ml_ads", "mlAds"],
  affiliates: ["affiliates", "affiliate"],
  safety_reserve: ["safety_reserve", "loss_reserve", "reserve", "loss_returns_reserve"],
};

/**
 * @param {unknown} source
 */
function asObject(source) {
  if (!source || typeof source !== "object") return null;
  return /** @type {Record<string, unknown>} */ (source);
}

/**
 * @param {unknown} raw
 */
function toNum(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, unknown>} node
 */
function readVarNode(node) {
  const enabled =
    node.enabled === true ||
    node.active === true ||
    node.on === true ||
    String(node.enabled ?? node.active ?? "").toLowerCase() === "true";
  const percentRaw = node.percent ?? node.pct ?? node.percent_value ?? node.percentage;
  const amountRaw = node.amount ?? node.amount_brl ?? node.value_brl ?? node.cost_brl;
  const pctNum = toNum(percentRaw);
  const amtNum = toNum(amountRaw);
  return {
    enabled,
    percent: pctNum != null ? String(pctNum) : null,
    amount: amtNum != null ? amtNum.toFixed(2) : null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} rawJson
 * @returns {PricingSimulationConfig}
 */
export function readPricingSimulationConfigFromRawJson(rawJson) {
  const root = asObject(rawJson);
  if (!root) return {};

  const sim = asObject(root[STORAGE_KEY]) ?? root;
  /** @type {PricingSimulationConfig} */
  const out = {};

  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const node = asObject(sim[alias]);
      if (!node) continue;
      out[canonical] = readVarNode(node);
      break;
    }
  }

  return out;
}

/**
 * @param {Record<string, unknown> | null | undefined} rawJson
 * @param {PricingSimulationConfig} config
 */
export function mergePricingSimulationConfigIntoRawJson(rawJson, config) {
  const root = asObject(rawJson) ? { .../** @type {Record<string, unknown>} */ (rawJson) } : {};
  /** @type {Record<string, unknown>} */
  const sim = {};

  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const entry = config[canonical];
    if (!entry) continue;
    const payload = {
      enabled: entry.enabled === true,
      percent: entry.percent,
      amount: entry.amount,
    };
    sim[aliases[0]] = payload;
  }

  root[STORAGE_KEY] = sim;
  return root;
}

export { STORAGE_KEY, FIELD_ALIASES };
