// ============================================================
// S7 — Concorrência: CompetitionEngine (resolver principal de descoberta)
// Recebe o contexto do produto, escolhe a(s) estratégia(s) por marketplace,
// executa com FALLBACK inteligente e devolve candidatos normalizados.
//
// Ordem (Mercado Livre):
//   1) catálogo (se houver catalog_product_id);
//   2) busca pública (fallback quando catálogo vazio/indisponível);
//   3) lista vazia (nunca erro).
//
// NÃO persiste, NÃO salva concorrente, NÃO cria snapshot. Apenas descobre.
// Preparado para Shopee/Amazon/Shein: basta registrar novas estratégias.
// ============================================================

import { MercadoLivreCatalogCompetitionStrategy } from "./strategies/MercadoLivreCatalogCompetitionStrategy.js";
import { MercadoLivreSearchCompetitionStrategy } from "./strategies/MercadoLivreSearchCompetitionStrategy.js";

/** Estratégias ordenadas por marketplace (a 1ª que retornar candidatos vence). */
function buildDefaultRegistry() {
  return {
    mercado_livre: [
      new MercadoLivreCatalogCompetitionStrategy(),
      new MercadoLivreSearchCompetitionStrategy(),
    ],
    // Futuro: shopee: [...], amazon: [...], shein: [...]
  };
}

export class CompetitionEngine {
  /** @param {{ registry?: Record<string, import("./CompetitionDiscoveryStrategy.js").CompetitionDiscoveryStrategy[]> }} [opts] */
  constructor(opts = {}) {
    this.registry = opts.registry || buildDefaultRegistry();
  }

  strategiesFor(marketplace) {
    const key = marketplace != null ? String(marketplace).trim() : "";
    return Array.isArray(this.registry[key]) ? this.registry[key] : [];
  }

  /**
   * Executa a descoberta com fallback. Nunca lança: falha de estratégia vira lista vazia,
   * e o engine tenta a próxima estratégia aplicável.
   * @param {Record<string, unknown>} context
   * @returns {Promise<{ strategy: string; results: object[] }>}
   */
  async discover(context) {
    // Bloco de debug opcional (preenchido pelas estratégias; sem dados sensíveis).
    const debug = context?.debug && typeof context.debug === "object" ? context.debug : null;

    const strategies = this.strategiesFor(context?.marketplace);
    if (!strategies.length) {
      console.info("[COMPETITION] No strategy registered for marketplace", {
        marketplace: context?.marketplace ?? null,
      });
      if (debug) debug.warning = "no_strategy_for_marketplace";
      return { strategy: "none", results: [] };
    }

    // Busca manual/paginada: pula catálogo (PDP fixa) e vai direto à busca ampla por palavra-chave.
    const strategiesToRun =
      context?.searchOnly === true || context?.broadSearch === true
        ? strategies.filter((s) => s.sourceStrategy === "ml_broad_search" || s.sourceStrategy === "ml_search")
        : strategies;

    let lastStrategyTried = "none";
    for (const strategy of strategiesToRun) {
      if (!strategy.supports(context)) continue;
      lastStrategyTried = strategy.sourceStrategy;
      if (debug && Array.isArray(debug.strategy_attempted)) {
        debug.strategy_attempted.push(strategy.sourceStrategy);
      }
      console.info("[COMPETITION] Strategy selected", { strategy: strategy.sourceStrategy });

      let found = [];
      try {
        found = await strategy.discover(context);
      } catch (e) {
        // Fallback: catálogo indisponível/erro → tenta a próxima (busca pública).
        console.warn("[COMPETITION] Strategy failed", {
          strategy: strategy.sourceStrategy,
          message: e?.message ?? String(e),
        });
        if (debug) debug.last_error = String(e?.message ?? e).slice(0, 200);
        found = [];
      }

      if (Array.isArray(found) && found.length > 0) {
        console.info("[COMPETITION] Candidates normalized", {
          strategy: strategy.sourceStrategy,
          total: found.length,
        });
        if (debug) debug.normalized_results_count = found.length;
        return { strategy: strategy.sourceStrategy, results: found };
      }
    }

    if (debug) {
      debug.normalized_results_count = 0;
      if (!debug.warning) debug.warning = "no_candidates_found";
    }
    console.info("[COMPETITION] No candidates after all strategies", { last_strategy: lastStrategyTried });
    return { strategy: lastStrategyTried, results: [] };
  }
}
