// ======================================================================
// M6 — contrato de navegação (backend retorna provider + action_type;
// rotas pertencem ao frontend — separação de camadas)
// ======================================================================

export const MARKETPLACE_ACTION_TYPES = /** @type {const} */ ({
  NAVIGATION: "NAVIGATION",
});

export const MARKETPLACE_PROVIDERS = /** @type {const} */ ({
  MERCADO_LIVRE: "MERCADO_LIVRE",
});

/** Referência documental — rota homologada no frontend (não exposta na API). */
export const MARKETPLACE_PROVIDER_FRONTEND_ROUTES = /** @type {const} */ ({
  [MARKETPLACE_PROVIDERS.MERCADO_LIVRE]: "/perfil/integracoes/mercado-livre",
});

/**
 * @param {string} provider
 */
export function montarAcaoNavegacaoMarketplace(provider) {
  const normalized = String(provider || "").trim().toUpperCase();
  if (!Object.values(MARKETPLACE_PROVIDERS).includes(normalized)) {
    return null;
  }
  return {
    type: MARKETPLACE_ACTION_TYPES.NAVIGATION,
    provider: normalized,
  };
}

/** Provider padrão para onboarding inicial (único implementado). */
export const MARKETPLACE_PROVIDER_ONBOARDING_INICIAL = MARKETPLACE_PROVIDERS.MERCADO_LIVRE;
