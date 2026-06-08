// ======================================================================
// Filtros semânticos (chips) — métricas executivas de vendas.
// ======================================================================

import Decimal from "decimal.js";

/**
 * @param {Decimal | null} profitDec
 * @param {Decimal | null} marginPercent
 * @param {Decimal | null} grossDec
 * @param {"healthy" | "critical" | "attention" | "unknown"} health
 */
export function matchesExecutiveSalesFilter(filter, profitDec, marginPercent, grossDec, health) {
  const id = filter != null && String(filter).trim() !== "" ? String(filter).trim() : "all";
  if (id === "all") return true;

  const profit = profitDec;
  const margin = marginPercent;
  const gross = grossDec;

  switch (id) {
    case "profit_high":
      return profit != null && profit.gt(0);
    case "loss":
      return profit != null && profit.lt(0);
    case "no_profit":
      return profit == null || profit.lte(0);
    case "margin_low":
      return (
        (margin != null && margin.lt(5) && (profit == null || profit.gte(0))) ||
        health === "attention"
      );
    case "needs_attention":
      return health === "attention" || health === "critical" || profit == null;
    case "ticket_high":
      return gross != null && gross.gte(200);
    case "ticket_low":
      return gross != null && gross.gt(0) && gross.lt(80);
    default:
      return true;
  }
}
