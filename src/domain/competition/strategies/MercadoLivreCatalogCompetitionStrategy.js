// ============================================================
// S7 — Concorrência: estratégia de CATÁLOGO (Mercado Livre / Fluxo A)
// Usa a competição oficial da PDP de catálogo:
//   - GET /items/{item_id}/price_to_win?version=v2  (contexto/log, best-effort)
//   - GET /products/{catalog_product_id}/items       (lista de concorrentes)
//   - GET /products/{catalog_product_id}             (metadados, best-effort)
// Detalha candidatos via multiget /items?ids= e normaliza no contrato único.
// Remove o próprio anúncio/seller e deduplica. Não persiste.
// ============================================================

import { CompetitionDiscoveryStrategy } from "../CompetitionDiscoveryStrategy.js";
import {
  fetchItemPriceToWin,
  fetchCatalogProductItems,
  fetchItemsByIds,
} from "../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { normalizeDiscoveredCompetitor } from "../competitionNormalizer.js";
import { mlItemBodyToCandidateRaw, isOwnCandidate } from "./mlCompetitorMapping.js";

export class MercadoLivreCatalogCompetitionStrategy extends CompetitionDiscoveryStrategy {
  get marketplace() {
    return "mercado_livre";
  }

  get sourceStrategy() {
    return "ml_catalog";
  }

  /** Só se aplica a anúncios de catálogo com catalog_product_id. */
  supports(context) {
    const cp = context?.listing?.catalogProductId;
    return Boolean(cp && String(cp).trim() !== "");
  }

  async discover(context) {
    const { accessToken, listing } = context;
    const catalogProductId = String(listing.catalogProductId).trim();
    const limit = Number(context.limit) > 0 ? Number(context.limit) : 20;

    // price_to_win é contexto competitivo do item do seller (log apenas; não bloqueia).
    if (listing.externalListingId) {
      try {
        const ptw = await fetchItemPriceToWin(accessToken, listing.externalListingId);
        console.info("[COMPETITION] price_to_win", {
          item_id: listing.externalListingId,
          status: ptw?.status ?? null,
        });
      } catch (e) {
        console.info("[COMPETITION] price_to_win unavailable", { message: e?.message ?? String(e) });
      }
    }

    const debug = context?.debug && typeof context.debug === "object" ? context.debug : null;
    if (debug && Array.isArray(debug.search_queries_attempted)) {
      debug.search_queries_attempted.push(`catalog:${catalogProductId}`);
    }

    const { results } = await fetchCatalogProductItems(accessToken, catalogProductId, { limit });
    const ids = [];
    for (const r of results) {
      const id = r?.item_id ?? r?.id;
      if (id != null && String(id).trim() !== "") ids.push(String(id).trim());
    }
    if (debug) debug.raw_results_count = (debug.raw_results_count || 0) + ids.length;
    console.info("[COMPETITION] Catalog competitors found", {
      catalog_product_id: catalogProductId,
      raw_count: ids.length,
    });
    if (!ids.length) return [];

    // Detalha os candidatos (título, preço, thumbnail, permalink, seller, shipping).
    let bodies = new Map();
    try {
      bodies = await fetchItemsByIds(accessToken, ids.slice(0, limit));
    } catch (e) {
      console.info("[COMPETITION] catalog multiget failed", { message: e?.message ?? String(e) });
    }

    const out = [];
    const seen = new Set();
    for (const id of ids.slice(0, limit)) {
      const source = bodies.get(String(id)) || results.find((r) => String(r?.item_id ?? r?.id) === String(id));
      const rawCand = mlItemBodyToCandidateRaw(source);
      if (!rawCand || !rawCand.competitor_listing_id) continue;
      if (isOwnCandidate(context, rawCand)) continue;
      if (seen.has(rawCand.competitor_listing_id)) continue;
      seen.add(rawCand.competitor_listing_id);
      out.push(normalizeDiscoveredCompetitor(rawCand, this.sourceStrategy));
    }
    return out;
  }
}
