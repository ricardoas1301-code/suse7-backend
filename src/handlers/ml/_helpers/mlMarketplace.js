/** Slug persistido em ml_tokens.marketplace (multi-marketplace futuro). */
export const ML_MARKETPLACE_SLUG = "mercado_livre";

/**
 * Valores aceitos em marketplace_listings.marketplace para o mesmo canal ML.
 * Import incremental compara com .in(...) para não reprocessar por divergência legada.
 */
export const ML_MARKETPLACE_LISTING_ALIASES = [ML_MARKETPLACE_SLUG, "mercadolivre"];
