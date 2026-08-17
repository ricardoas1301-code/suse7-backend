// ======================================================================
// Classificador SSOT — saúde cadastro / operacional / comercial / atenção.
// Reutilizável pelo Dashboard e futuros filtros da página Anúncios.
// ======================================================================

import Decimal from "decimal.js";
import {
  LISTING_HEALTH_CRITICAL_STOCK_THRESHOLD,
  LISTING_HEALTH_HEALTHY_MARGIN_MIN_PCT,
  LISTING_HEALTH_REGISTRATION_ATTENTION_MIN,
  LISTING_HEALTH_REGISTRATION_HEALTHY_MIN,
} from "./listingHealthConstants.js";

/**
 * @param {unknown} raw
 * @returns {Decimal | null}
 */
function toDecimalOrNull(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const dec = new Decimal(String(raw).trim().replace(",", "."));
    return dec.isFinite() ? dec : null;
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function classificarEstoqueOperacional(snapshot) {
  const qty = snapshot.available_quantity;
  if (qty == null) {
    return { is_zero_stock: false, is_critical_stock: false, stock_health: "unknown" };
  }
  if (qty <= 0) {
    return { is_zero_stock: true, is_critical_stock: false, stock_health: "zero" };
  }
  if (qty <= LISTING_HEALTH_CRITICAL_STOCK_THRESHOLD) {
    return { is_zero_stock: false, is_critical_stock: true, stock_health: "critical" };
  }
  return { is_zero_stock: false, is_critical_stock: false, stock_health: "healthy" };
}

/**
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function classificarSaudeCadastro(snapshot) {
  const score = snapshot.health_score;
  if (score == null) {
    return {
      band: /** @type {"unknown"} */ ("unknown"),
      needs_improvement: !snapshot.is_product_ready || snapshot.pending_goals_count > 0,
    };
  }
  if (score >= LISTING_HEALTH_REGISTRATION_HEALTHY_MIN && snapshot.is_product_ready) {
    return { band: /** @type {"healthy"} */ ("healthy"), needs_improvement: score < 100 || snapshot.pending_goals_count > 0 };
  }
  if (score >= LISTING_HEALTH_REGISTRATION_ATTENTION_MIN) {
    return { band: /** @type {"attention"} */ ("attention"), needs_improvement: true };
  }
  return { band: /** @type {"critical"} */ ("critical"), needs_improvement: true };
}

/**
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function classificarSaudeComercial(snapshot) {
  const profitDec = toDecimalOrNull(snapshot.profit_brl);
  const marginDec = toDecimalOrNull(snapshot.profit_margin_percent);
  const sales = snapshot.sales_count ?? 0;
  const isActive = snapshot.status_normalized === "active";

  const hasNegativeProfit = profitDec != null && profitDec.isNegative();
  const hasCriticalMargin =
    marginDec != null &&
    marginDec.gte(0) &&
    marginDec.lt(LISTING_HEALTH_HEALTHY_MARGIN_MIN_PCT) &&
    sales > 0;
  const activeWithoutSales = isActive && sales === 0;

  let band = /** @type {"healthy" | "attention" | "critical" | "unknown"} */ ("unknown");
  if (hasNegativeProfit) band = "critical";
  else if (hasCriticalMargin || activeWithoutSales) band = "attention";
  else if (sales > 0) band = "healthy";

  return {
    band,
    has_negative_profit: hasNegativeProfit,
    has_critical_margin: hasCriticalMargin,
    active_without_sales: activeWithoutSales,
  };
}

/**
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function classificarSaudeOperacional(snapshot) {
  const stock = classificarEstoqueOperacional(snapshot);
  const status = snapshot.status_normalized;

  let band = /** @type {"healthy" | "attention" | "critical" | "unknown"} */ ("healthy");
  let reasonKey = "ok";
  let reasonLabel = "Operação regular";
  let severity = /** @type {"healthy" | "attention" | "critical"} */ ("healthy");

  if (stock.is_zero_stock) {
    band = "critical";
    reasonKey = "zero_stock";
    reasonLabel = "Sem estoque";
    severity = "critical";
  } else if (status === "inactive" || status === "paused") {
    band = "critical";
    reasonKey = status === "paused" ? "paused" : "inactive";
    reasonLabel = status === "paused" ? "Pausado" : "Inativo";
    severity = "critical";
  } else if (stock.is_critical_stock) {
    band = "attention";
    reasonKey = "critical_stock";
    reasonLabel = "Estoque crítico";
    severity = "attention";
  } else if (status === "unknown") {
    band = "attention";
    reasonKey = "status_unknown";
    reasonLabel = "Status indefinido";
    severity = "attention";
  }

  return {
    band,
    reason_key: reasonKey,
    reason_label: reasonLabel,
    severity,
    ...stock,
    is_paused: status === "paused",
    is_inactive: status === "inactive",
    is_active: status === "active",
  };
}

/**
 * Motor único — regra compartilhada Dashboard + filtro "Precisam atenção" (futuro).
 *
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function anuncioPrecisaAtencao(snapshot) {
  const cadastro = classificarSaudeCadastro(snapshot);
  const operacional = classificarSaudeOperacional(snapshot);
  const comercial = classificarSaudeComercial(snapshot);

  return (
    cadastro.needs_improvement ||
    snapshot.pending_goals_count > 0 ||
    snapshot.needs_attention_flag === true ||
    snapshot.sku_pending === true ||
    operacional.severity !== "healthy" ||
    comercial.has_negative_profit ||
    comercial.has_critical_margin ||
    comercial.active_without_sales
  );
}

/**
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function anuncioEmRiscoEstoque(snapshot) {
  const stock = classificarEstoqueOperacional(snapshot);
  return stock.is_zero_stock || stock.is_critical_stock;
}

/**
 * @param {ReturnType<import("./adapters/mercadoLivreListingHealthAdapter.js").normalizeMercadoLivreListingHealthSnapshot>} snapshot
 */
export function montarClassificacaoCompletaAnuncio(snapshot) {
  const cadastro = classificarSaudeCadastro(snapshot);
  const operacional = classificarSaudeOperacional(snapshot);
  const comercial = classificarSaudeComercial(snapshot);

  const pendingGoals = snapshot.pending_goals_count ?? 0;
  const registrationReasonLabel =
    pendingGoals > 0
      ? `${pendingGoals} ajuste${pendingGoals === 1 ? "" : "s"} pendente${pendingGoals === 1 ? "" : "s"}`
      : cadastro.needs_improvement
        ? "Cadastro incompleto"
        : "Cadastro regular";

  let commercialReasonLabel = "Comercial regular";
  let commercialSeverity = /** @type {"healthy" | "attention" | "critical"} */ ("healthy");
  if (comercial.has_negative_profit) {
    commercialReasonLabel = "Vendendo com prejuízo";
    commercialSeverity = "critical";
  } else if (comercial.has_critical_margin) {
    commercialReasonLabel = "Margem crítica";
    commercialSeverity = "attention";
  } else if (comercial.active_without_sales) {
    commercialReasonLabel = "Ativo sem venda no período";
    commercialSeverity = "attention";
  }

  return {
    cadastro,
    operacional,
    comercial,
    needs_attention: anuncioPrecisaAtencao(snapshot),
    stock_risk: anuncioEmRiscoEstoque(snapshot),
    registration_reason_label: registrationReasonLabel,
    operational_reason_label: operacional.reason_label,
    commercial_reason_label: commercialReasonLabel,
    commercial_severity: commercialSeverity,
  };
}

/**
 * Prioridade operacional para ranking (menor = mais urgente).
 * @param {string} reasonKey
 */
export function prioridadeOperacional(reasonKey) {
  const map = {
    zero_stock: 1,
    paused: 2,
    inactive: 2,
    critical_stock: 3,
    status_unknown: 4,
    ok: 99,
  };
  return map[/** @type {keyof typeof map} */ (reasonKey)] ?? 50;
}

/**
 * Prioridade comercial para ranking.
 * @param {ReturnType<typeof classificarSaudeComercial>} comercial
 */
export function prioridadeComercial(comercial) {
  if (comercial.has_negative_profit) return 1;
  if (comercial.has_critical_margin) return 2;
  if (comercial.active_without_sales) return 3;
  return 99;
}
