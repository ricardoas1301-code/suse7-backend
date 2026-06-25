// ======================================================
// Resultado do Raio-x da venda — saúde por margem líquida %.
// Fonte única: backend classifica; frontend só exibe payload.
// ======================================================

import Decimal from "decimal.js";
import { classifyOfferMarginStatus } from "../offerMarginStatus.js";

/**
 * Faixas de margem líquida (lucro / valor da venda × 100), alinhadas a `offerMarginStatus.js`.
 *
 * | Faixa (margem %) | Rótulo Raio-x   | Shell visual |
 * |------------------|-----------------|--------------|
 * | lucro < 0        | Crítico         | critical     |
 * | margem < 0       | Crítico         | critical     |
 * | 0 ≤ m ≤ 7        | Atenção         | attention    |
 * | 7 < m ≤ 15       | Bom             | healthy      |
 * | 15 < m ≤ 25      | Ótimo           | healthy      |
 * | m > 25           | Excelente       | healthy      |
 */
export const SALE_RAYX_HEALTH_THRESHOLDS_DOC = {
  critical: { condition: "lucro < 0 ou margem < 0", label: "Crítico", shell: "critical" },
  attention: { condition: "0 ≤ margem ≤ 7%", label: "Atenção", shell: "attention" },
  bom: { condition: "7% < margem ≤ 15%", label: "Bom", shell: "healthy" },
  otimo: { condition: "15% < margem ≤ 25%", label: "Ótimo", shell: "healthy" },
  excelente: { condition: "margem > 25%", label: "Excelente", shell: "healthy" },
};

/** @type {Record<string, string>} */
const RAYX_LABEL_BY_SEMANTIC = {
  critical: "Crítico",
  danger: "Atenção",
  acceptable: "Bom",
  great: "Ótimo",
  excellent: "Excelente",
};

/** @type {Record<string, "critical" | "attention" | "healthy">} */
const SHELL_BY_SEMANTIC = {
  critical: "critical",
  danger: "attention",
  acceptable: "healthy",
  great: "healthy",
  excellent: "healthy",
};

/**
 * @param {import("decimal.js").Decimal | null | undefined} profitDec
 * @param {string | null | undefined} marginPercentStr
 */
export function classifySaleRayxResultHealth(profitDec, marginPercentStr) {
  const marginDec =
    marginPercentStr != null && String(marginPercentStr).trim() !== ""
      ? new Decimal(String(marginPercentStr).replace(",", "."))
      : null;

  const ui = classifyOfferMarginStatus(marginDec, profitDec);
  const semantic = ui.offer_status_semantic;
  const shell = SHELL_BY_SEMANTIC[semantic] ?? "unknown";

  return {
    health_label: RAYX_LABEL_BY_SEMANTIC[semantic] ?? ui.offer_status_label,
    health_status: shell,
    health: shell,
    offer_status_key: ui.offer_status_key,
    offer_status_label: RAYX_LABEL_BY_SEMANTIC[semantic] ?? ui.offer_status_label,
    offer_status_semantic: semantic,
    offer_status_title: ui.offer_status_title,
    offer_status_subtitle: ui.offer_status_subtitle,
    offer_status_message: ui.offer_status_message,
  };
}
