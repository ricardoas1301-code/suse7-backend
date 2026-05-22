// =============================================================================
// Catálogo UI seller — labels e agrupamento (Fase 3.1.1)
// =============================================================================

import { S7_NOTIFICATION_CATEGORY } from "../constants/categories.js";
import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

/** Categorias ocultas para sellers normais */
export const SELLER_HIDDEN_CATEGORIES = new Set([S7_NOTIFICATION_CATEGORY.DEVCENTER]);

/** @type {Record<string, { label: string, description: string, sortOrder: number }>} */
export const SELLER_CATEGORY_UI = Object.freeze({
  [S7_NOTIFICATION_CATEGORY.BILLING]: {
    label: "Billing",
    description: "Assinatura, pagamentos e renovações",
    sortOrder: 10,
  },
  [S7_NOTIFICATION_CATEGORY.SALES]: {
    label: "Vendas",
    description: "Pedidos e movimentação de vendas",
    sortOrder: 20,
  },
  [S7_NOTIFICATION_CATEGORY.PROFIT]: {
    label: "Lucro e margem",
    description: "Rentabilidade e prejuízo",
    sortOrder: 30,
  },
  [S7_NOTIFICATION_CATEGORY.PRODUCTS]: {
    label: "Produtos",
    description: "Catálogo e cadastro",
    sortOrder: 40,
  },
  [S7_NOTIFICATION_CATEGORY.INVENTORY]: {
    label: "Estoque",
    description: "Disponibilidade e ruptura",
    sortOrder: 50,
  },
  [S7_NOTIFICATION_CATEGORY.MARKETPLACE]: {
    label: "Anúncios e marketplace",
    description: "Integrações e anúncios",
    sortOrder: 60,
  },
  [S7_NOTIFICATION_CATEGORY.ACCOUNT_HEALTH]: {
    label: "Saúde da conta",
    description: "Conta, limites e conexões",
    sortOrder: 70,
  },
  [S7_NOTIFICATION_CATEGORY.COMPETITION]: {
    label: "Concorrência",
    description: "Posicionamento competitivo",
    sortOrder: 80,
  },
  [S7_NOTIFICATION_CATEGORY.SYNC]: {
    label: "Sincronização",
    description: "Jobs e sync de dados",
    sortOrder: 90,
  },
  [S7_NOTIFICATION_CATEGORY.SYSTEM]: {
    label: "Sistema",
    description: "Alertas operacionais",
    sortOrder: 100,
  },
  [S7_NOTIFICATION_CATEGORY.DEVCENTER]: {
    label: "DevCenter",
    description: "Observabilidade interna",
    sortOrder: 999,
  },
});

export const SELLER_CHANNEL_UI = Object.freeze([
  {
    key: S7_NOTIFICATION_CHANNEL.IN_APP,
    label: "No app",
    description: "Central de notificações dentro do Suse7",
    future: false,
  },
  {
    key: S7_NOTIFICATION_CHANNEL.EMAIL,
    label: "E-mail",
    description: "Envio para caixas cadastradas",
    future: false,
  },
  {
    key: S7_NOTIFICATION_CHANNEL.WHATSAPP,
    label: "WhatsApp",
    description: "Mensagens para números autorizados",
    future: false,
  },
  {
    key: S7_NOTIFICATION_CHANNEL.PUSH,
    label: "Pop-up",
    description: "Alertas em tempo real no navegador (em breve)",
    future: true,
  },
]);

/**
 * @param {boolean} includeDevCenter
 */
export function isCategoryVisibleToSeller(categoryCode, includeDevCenter = false) {
  if (includeDevCenter) return true;
  return !SELLER_HIDDEN_CATEGORIES.has(String(categoryCode));
}
