// ============================================================
// S7 — Concorrência: contrato base de estratégia de descoberta
// Strategy Pattern multi-marketplace (preparado p/ Shopee/Amazon/Shein).
//
// Cada estratégia: identifica o marketplace, diz se se aplica ao contexto
// (supports) e executa a descoberta retornando candidatos JÁ normalizados
// (normalizeDiscoveredCompetitor). Nenhuma estratégia persiste dados.
//
// DiscoveryContext (shape esperado):
// {
//   userId: string,
//   marketplace: "mercado_livre",
//   accessToken: string,
//   limit: number,
//   query?: string | null,                // override opcional do seller
//   product: { id, sku, product_name },
//   listing: {
//     externalListingId: string | null,
//     catalogProductId: string | null,
//     catalogListing: boolean,
//     categoryId: string | null,
//     title: string | null,
//     brand: string | null,
//     gtin: string | null,
//   },
//   ownListingId: string | null,
//   ownSellerId: string | null,
// }
// ============================================================

export class CompetitionDiscoveryStrategy {
  /** Slug do marketplace ("mercado_livre", "shopee", ...). */
  get marketplace() {
    return "base";
  }

  /** Identificador da estratégia, gravado depois em source_strategy. */
  get sourceStrategy() {
    return "base";
  }

  /** Diz se a estratégia se aplica ao contexto (ex.: catálogo x não-catálogo). */
  // eslint-disable-next-line no-unused-vars
  supports(context) {
    return false;
  }

  /** Executa a descoberta e devolve candidatos normalizados. */
  // eslint-disable-next-line no-unused-vars
  async discover(context) {
    return [];
  }
}
