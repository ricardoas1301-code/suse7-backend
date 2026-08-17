// ============================================================
// Catálogo central — tipos de notificação para roteamento (Fase 1)
// Mantido alinhado com suse7-frontend/src/constants/notificationRoutingCatalog.js
// ============================================================

export const NOTIFICATION_ROUTING_CHANNELS = {
  app: "app",
  email: "email",
  whatsapp: "whatsapp",
};

/** @type {ReadonlyArray<{
 *   key: string,
 *   label: string,
 *   description: string,
 *   category: string,
 *   priority: string,
 *   supportsAccountRouting: boolean,
 *   supportedChannels: ReadonlyArray<'app'|'email'|'whatsapp'>
 * }>} */
export const NOTIFICATION_ROUTING_TYPE_CATALOG = Object.freeze([
  {
    key: "alteracao_preco_marketplace",
    label: "Alteração de preço no marketplace",
    description: "Quando o preço público do anúncio mudar frente ao último snapshot.",
    category: "anuncios_marketplace",
    priority: "important",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "alteracao_comissao_tarifa",
    label: "Alteração de comissão ou tarifa",
    description: "Quando comissão ou tarifa de venda mudar versus o snapshot anterior.",
    category: "anuncios_marketplace",
    priority: "important",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "alteracao_frete",
    label: "Alteração de frete",
    description: "Quando o custo ou modalidade de frete relevante ao seller mudar.",
    category: "anuncios_marketplace",
    priority: "important",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "frete_aumentou",
    label: "Frete aumentou",
    description: "Alerta quando o frete efetivo subir acima de um limiar configurável (motor futuro).",
    category: "anuncios_marketplace",
    priority: "important",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "perda_competitividade",
    label: "Perda de competitividade",
    description: "Quando o anúncio perder relevância ou posição competitiva.",
    category: "anuncios_marketplace",
    priority: "medium",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "melhoria_oportunidade",
    label: "Melhoria ou oportunidade",
    description: "Quando houver espaço para melhorar margem, preço ou exposição.",
    category: "anuncios_marketplace",
    priority: "info",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "margem_negativa",
    label: "Margem negativa ou prejuízo",
    description: "Vendas ou cenários em que a margem líquida fica negativa.",
    category: "vendas_lucro",
    priority: "critical",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "venda_diaria",
    label: "Resumo de vendas do dia",
    description: "Consolidado diário de vendas e resultado.",
    category: "vendas_lucro",
    priority: "info",
    supportsAccountRouting: false,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "conta_desconectada",
    label: "Conta marketplace desconectada",
    description: "Quando a conta perder autorização ou token válido.",
    category: "conta_operacao",
    priority: "critical",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "venda_cancelada",
    label: "Venda cancelada",
    description: "Pedidos cancelados ou revertidos que impactem estoque e financeiro.",
    category: "vendas_lucro",
    priority: "important",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
  {
    key: "estoque_baixo",
    label: "Estoque baixo ou crítico",
    description: "Produtos abaixo do mínimo, próximos de zerar ou já zerados.",
    category: "produtos_estoque",
    priority: "important",
    supportsAccountRouting: true,
    supportedChannels: ["app", "email", "whatsapp"],
  },
]);

export const NOTIFICATION_ROUTING_TYPE_KEYS = new Set(NOTIFICATION_ROUTING_TYPE_CATALOG.map((t) => t.key));

/** @type {Record<string, typeof NOTIFICATION_ROUTING_TYPE_CATALOG[number]>} */
export const NOTIFICATION_ROUTING_TYPE_LOOKUP = NOTIFICATION_ROUTING_TYPE_CATALOG.reduce((acc, row) => {
  acc[row.key] = row;
  return acc;
}, {});

export function isValidRoutingNotificationType(key) {
  return typeof key === "string" && NOTIFICATION_ROUTING_TYPE_KEYS.has(key);
}

export function isValidRoutingChannel(ch) {
  return ch === "app" || ch === "email" || ch === "whatsapp";
}

/**
 * Chave legada em user_preferences (`notify.<TIPO>`) representativa do tipo de roteamento.
 * Usada só para ler toggles de canal (app/e-mail/WhatsApp) sem migrar JSON antigo.
 */
export const ROUTING_TO_PRIMARY_LEGACY_PREF_KEY = Object.freeze({
  alteracao_preco_marketplace: "MARKETPLACE_PRICE_CHANGED",
  alteracao_comissao_tarifa: "MARKETPLACE_FEE_CHANGED",
  alteracao_frete: "MARKETPLACE_SHIPPING_CHANGED",
  frete_aumentou: "MARKETPLACE_SHIPPING_CHANGED",
  perda_competitividade: "LISTING_COMPETITIVENESS_LOST",
  melhoria_oportunidade: "LISTING_OPPORTUNITY_FOUND",
  margem_negativa: "NEGATIVE_SALE",
  venda_diaria: "DAILY_SALES_SUMMARY",
  conta_desconectada: "ACCOUNT_HEALTH_ALERT",
  venda_cancelada: "NEGATIVE_SALE",
  estoque_baixo: "LOW_STOCK",
});

/**
 * @param {string} routingKey
 * @returns {string | null}
 */
export function getPrimaryLegacyPrefKeyForRouting(routingKey) {
  const k = routingKey != null ? String(routingKey).trim() : "";
  return ROUTING_TO_PRIMARY_LEGACY_PREF_KEY[k] ?? null;
}
