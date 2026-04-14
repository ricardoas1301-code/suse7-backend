// ======================================================
// Status da oferta (Raio-x) a partir da margem líquida %.
// Regra Suse7: classificação e copy só no backend; frontend só exibe payload.
// Extensível para outros marketplaces no futuro.
// ======================================================

import Decimal from "decimal.js";

/**
 * @typedef {{
 *   offer_status_key: string;
 *   offer_status_label: string;
 *   offer_status_semantic: string;
 *   offer_status_title: string;
 *   offer_status_subtitle: string;
 *   offer_status_message: string;
 *   offer_status_tooltip: string;
 * }} OfferMarginUi
 * offer_status_tooltip espelha offer_status_message (compat APIs antigas).
 */

/** Copy oficial por faixa semântica (título / subtítulo / mensagem). */
const STATUS_COPY = /** @type {const} */ ({
  critical: {
    offer_status_title: "Crítico (Prejuízo)",
    offer_status_subtitle: "Operação Deficitária",
    offer_status_message:
      "O cenário atual indica margem negativa. Para preservar a saúde financeira do seu negócio, recomendamos a revisão imediata da precificação ou a pausa estratégica do anúncio.",
  },
  danger: {
    offer_status_title: "Alerta (Risco)",
    offer_status_subtitle: "Margem de Exposição",
    offer_status_message:
      "Rentabilidade comprimida. O anúncio possui baixa resiliência a variações de custo, exigindo monitoramento rigoroso para evitar perdas operacionais.",
  },
  acceptable: {
    offer_status_title: "Aceitável (Equilíbrio)",
    offer_status_subtitle: "Operação Sustentável",
    offer_status_message:
      "Margem alinhada à média de mercado. O anúncio sustenta a operação, mas apresenta uma margem de segurança limitada contra imprevistos.",
  },
  great: {
    offer_status_title: "Ótimo (Saudável)",
    offer_status_subtitle: "Performance Sólida",
    offer_status_message:
      "Rentabilidade saudável. Este patamar permite absorver variações de mercado e oferece fluxo para investimentos em tráfego e escala.",
  },
  excellent: {
    offer_status_title: "Excelente (Premium)",
    offer_status_subtitle: "Máxima Rentabilidade",
    offer_status_message:
      "Desempenho financeiro superior. O produto está posicionado no quadrante de alta lucratividade, sendo um pilar estratégico para o crescimento do lucro líquido.",
  },
});

/**
 * @param {"critical" | "danger" | "acceptable" | "great" | "excellent"} semantic
 * @param {{ key: string; label: string }} row
 * @returns {OfferMarginUi}
 */
function buildMarginUi(semantic, row) {
  const c = STATUS_COPY[semantic];
  return {
    offer_status_key: row.key,
    offer_status_label: row.label,
    offer_status_semantic: semantic,
    offer_status_title: c.offer_status_title,
    offer_status_subtitle: c.offer_status_subtitle,
    offer_status_message: c.offer_status_message,
    offer_status_tooltip: c.offer_status_message,
  };
}

/**
 * @param {Decimal | null | undefined} marginPct — margem líquida / preço de venda * 100
 * @param {Decimal | null | undefined} profit — lucro em R$ (para prejuízo explícito)
 * @returns {OfferMarginUi}
 */
export function classifyOfferMarginStatus(marginPct, profit) {
  const profitNeg = profit != null && profit.isFinite() && profit.lt(0);
  if (profitNeg) {
    return buildMarginUi("critical", { key: "critical", label: "Crítico" });
  }

  if (marginPct == null || !marginPct.isFinite()) {
    return buildMarginUi("acceptable", { key: "acceptable", label: "Aceitável" });
  }

  const m = marginPct;
  if (m.lt(0)) {
    return buildMarginUi("critical", { key: "critical", label: "Crítico" });
  }
  if (m.lte(7)) {
    return buildMarginUi("danger", { key: "danger", label: "Alerta" });
  }
  if (m.lte(15)) {
    return buildMarginUi("acceptable", { key: "acceptable", label: "Aceitável" });
  }
  if (m.lte(25)) {
    return buildMarginUi("great", { key: "great", label: "Ótimo" });
  }
  return buildMarginUi("excellent", { key: "excellent", label: "Excelente" });
}
