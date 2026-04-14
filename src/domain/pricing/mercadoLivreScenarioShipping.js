// ======================================================
// Frete por cenário (multi-promo / Raio-X) — Mercado Livre
// Não ancorar em shipping_cost coluna do health para o preço da aba:
// recalcular a partir do net_proceeds daquele cenário + GAP coerente.
// ======================================================

import Decimal from "decimal.js";

const EPS_GAP = new Decimal("0.04");
const ROUND = Decimal.ROUND_HALF_UP;

/** Placeholder ML não financeiro (cf. mercadoLivreShippingCostOfficial). */
function isPlaceholderShippingAmount(d) {
  if (d == null || !d.isFinite()) return true;
  if (d.gt(0) && d.lte(1)) return true;
  return false;
}

/** @param {unknown} v @returns {Decimal | null} */
function dMoney(v) {
  if (v == null || v === "") return null;
  try {
    const x = new Decimal(String(v).replace(",", "."));
    return x.isFinite() ? x : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
function decStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * Resolve custo de envio **para o preço da aba**, usando o payload de net_proceeds
 * já calculado para esse mesmo preço (não reutilizar frete persistido de outro preço).
 *
 * Ordem:
 * 1) Campos de frete no `np` deste cenário (se plausíveis)
 * 2) GAP: preço da aba − tarifa R$ − repasse (mesmo `np`)
 * 3) Auxiliar `raw_json.suse7_shipping_cost.auxiliary_amount_brl` (estimativa; fallback principal)
 *
 * @param {{
 *   scenarioSaleDec: Decimal;
 *   npRec: Record<string, unknown>;
 *   healthOriginal: Record<string, unknown> | null | undefined;
 * }} p
 * @returns {{ amount_brl: string | null; source: string }}
 */
export function resolveMercadoLivreScenarioShipping(p) {
  const { scenarioSaleDec, npRec, healthOriginal } = p;
  const shippingContextRaw =
    npRec.ml_shipping_cost_context ??
    npRec.shipping_cost_context ??
    healthOriginal?.shipping_cost_context ??
    healthOriginal?.ml_shipping_cost_context ??
    null;
  const shippingContext =
    shippingContextRaw != null && String(shippingContextRaw).trim() !== ""
      ? String(shippingContextRaw).trim().toLowerCase()
      : null;
  const logisticTypeRaw =
    npRec.shipping_logistic_type ??
    healthOriginal?.shipping_logistic_type ??
    null;
  const logisticType =
    logisticTypeRaw != null && String(logisticTypeRaw).trim() !== ""
      ? String(logisticTypeRaw).trim().toLowerCase()
      : null;

  const srcFromNp = () => {
    const raw =
      npRec.ml_shipping_cost_source ??
      npRec.shipping_cost_source ??
      npRec.shipping_cost_label ??
      null;
    return raw != null && String(raw).trim() !== "" ? String(raw).trim() : "net_proceeds";
  };

  // 1) Frete já preenchido pelo calculador para este preço
  const fromNpRaw =
    npRec.shipping_cost_amount_brl ?? npRec.shipping_cost_amount ?? npRec.ml_shipping_cost_amount_brl ?? null;
  if (fromNpRaw != null && String(fromNpRaw).trim() !== "") {
    const n = dMoney(fromNpRaw);
    if (n != null && n.isFinite() && !isPlaceholderShippingAmount(n)) {
      const suspiciousLowContextual =
        n.gt(0) &&
        n.lte(2) &&
        (shippingContext === "free_for_buyer" ||
          (logisticType != null &&
            /(full|xd_drop_off|fulfillment|cross_docking|self_service_in|meli_full)/i.test(logisticType)));
      if (suspiciousLowContextual) {
        // Valor pequeno espúrio (ex.: 1.35/1.65) não deve bloquear GAP/auxiliar em contextos Full/free_for_buyer.
      } else {
        return { amount_brl: decStr2(n), source: srcFromNp() };
      }
    }
    if (n != null && n.isFinite() && n.isZero()) {
      return { amount_brl: "0.00", source: srcFromNp() };
    }
  }

  // 2) GAP no próprio cenário (mesma evidência numérica do np)
  const fee = dMoney(npRec.sale_fee_amount);
  const net = dMoney(
    npRec.net_proceeds_amount ?? npRec.marketplace_payout_amount_brl ?? npRec.marketplace_payout_amount
  );
  if (
    scenarioSaleDec != null &&
    scenarioSaleDec.isFinite() &&
    scenarioSaleDec.gt(0) &&
    fee != null &&
    net != null &&
    net.gte(0)
  ) {
    const implied = scenarioSaleDec.minus(fee).minus(net);
    if (implied.gte(0) && implied.lt(scenarioSaleDec) && (implied.gt(EPS_GAP) || implied.isZero())) {
      return { amount_brl: decStr2(implied), source: "net_receivable_gap" };
    }
  }

  // 3) Simulação auxiliar persistida (estimativa; fallback principal quando faltam fontes melhores)
  const rj = healthOriginal?.raw_json;
  if (rj && typeof rj === "object" && !Array.isArray(rj)) {
    const suse7 = /** @type {Record<string, unknown>} */ (rj).suse7_shipping_cost;
    if (suse7 && typeof suse7 === "object") {
      const aux = /** @type {Record<string, unknown>} */ (suse7).auxiliary_amount_brl;
      const auxN = dMoney(aux);
      if (auxN != null && auxN.isFinite() && !isPlaceholderShippingAmount(auxN)) {
        const auxSourceRaw = /** @type {Record<string, unknown>} */ (suse7).auxiliary_source;
        const auxSource =
          auxSourceRaw != null && String(auxSourceRaw).trim() !== ""
            ? String(auxSourceRaw).trim()
            : "ml_shipping_options_free_simulation";
        return { amount_brl: decStr2(auxN), source: auxSource };
      }
    }
  }

  return { amount_brl: null, source: "unresolved" };
}

/**
 * Contexto de envio já normalizado no net_proceeds / health (evita inferência no frontend).
 * @param {Record<string, unknown>} npRec
 * @param {Record<string, unknown> | null | undefined} healthOriginal
 * @returns {"buyer_pays" | "free_for_buyer" | null}
 */
export function inferMercadoLivreShippingContext(npRec, healthOriginal) {
  const raw =
    npRec.ml_shipping_cost_context ??
    npRec.shipping_cost_context ??
    healthOriginal?.shipping_cost_context ??
    healthOriginal?.ml_shipping_cost_context ??
    null;
  if (raw === "free_for_buyer" || raw === "buyer_pays") return raw;
  if (raw != null && String(raw).trim() !== "") {
    const s = String(raw).trim().toLowerCase();
    if (s === "free_for_buyer" || s === "buyer_pays") return /** @type {"buyer_pays" | "free_for_buyer"} */ (s);
  }
  return null;
}
