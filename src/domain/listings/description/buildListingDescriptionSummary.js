// ======================================================================
// Monta description_summary normalizado para o Raio-X do Anúncio
// ======================================================================

/**
 * @param {unknown} value
 */
export function textoOuNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text !== "" && text !== "—" ? text : null;
}

/**
 * @param {{
 *   marketplaceDescription?: string | null;
 *   localDescription?: string | null;
 * }} input
 */
export function buildListingDescriptionSummary(input) {
  const marketplaceDescription = textoOuNull(input.marketplaceDescription);
  const localDescription = textoOuNull(input.localDescription);

  if (localDescription != null) {
    return {
      marketplace_description: marketplaceDescription,
      local_description: localDescription,
      effective_description: localDescription,
      effective_source: "local_override",
    };
  }

  if (marketplaceDescription != null) {
    return {
      marketplace_description: marketplaceDescription,
      local_description: null,
      effective_description: marketplaceDescription,
      effective_source: "marketplace_default",
    };
  }

  return {
    marketplace_description: null,
    local_description: null,
    effective_description: "",
    effective_source: "none",
  };
}
