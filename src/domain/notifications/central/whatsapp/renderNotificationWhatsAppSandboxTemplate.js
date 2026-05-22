// =============================================================================
// Template WhatsApp sandbox — copy premium, mobile-first (Fase 3.5B)
// =============================================================================

import { config } from "../../../../infra/config.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";

const IDEAL_MAX_CHARS = 500;
const HARD_MAX_CHARS = 4096;

/**
 * @param {string} category
 * @param {string} type
 */
function sandboxEmoji(category, type) {
  const t = String(type).toUpperCase();
  if (["PAYMENT_FAILED", "SUSPENDED", "MARKETPLACE_DISCONNECTED", "SYNC_FAILED"].includes(t)) {
    return "🚨";
  }
  if (["ENTERED_GRACE", "NEGATIVE_MARGIN", "LOW_STOCK"].includes(t)) {
    return "⚠️";
  }
  if (category === "BILLING" && t === "PAYMENT_CONFIRMED") return "✅";
  return "📣";
}

/**
 * Título curto para linha 1 (sem repetir corpo longo).
 * @param {string} category
 * @param {string} type
 * @param {string} fallback
 */
function sandboxHeadline(category, type, fallback) {
  const map = {
    "BILLING:PAYMENT_CONFIRMED": "Pagamento confirmado",
    "BILLING:PAYMENT_FAILED": "Pagamento pendente",
    "BILLING:RENEWAL_COMPLETED": "Renovação próxima",
    "BILLING:ENTERED_GRACE": "Período de carência",
    "PROFIT:NEGATIVE_MARGIN": "Prejuízo na venda",
    "INVENTORY:LOW_STOCK": "Margem em atenção",
    "MARKETPLACE:PRICE_CHANGED": "Frete alterado",
    "MARKETPLACE:FEE_CHANGED": "Taxa alterada",
    "ACCOUNT_HEALTH:MARKETPLACE_DISCONNECTED": "Conta crítica",
    "SYNC:SYNC_FAILED": "Sync falhou",
    "SYSTEM:SYSTEM_ALERT": "Alerta operacional",
  };
  const key = `${category}:${type}`;
  return map[key] ?? String(fallback ?? "Notificação").replace(/\s*—\s*.*/, "").slice(0, 60);
}

/**
 * Resumo em uma frase — sem IDs, JSON ou HTML.
 * @param {string} raw
 */
function toSummaryLine(raw) {
  let text = String(raw ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 220) text = `${text.slice(0, 217)}...`;
  return text;
}

/**
 * @param {{
 *   subject?: string;
 *   title?: string;
 *   message?: string;
 *   category?: string;
 *   type?: string;
 *   deepLink?: string | null;
 *   payload?: Record<string, unknown>;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   ctaLabel?: string;
 * }} input
 */
export function renderNotificationWhatsAppSandboxTemplate(input) {
  const category = String(input.category ?? "").trim();
  const type = String(input.type ?? "").trim();
  const titleFallback = String(input.title ?? input.subject ?? "Notificação Suse7").trim();
  const headline = sandboxHeadline(category, type, titleFallback);
  const summary = toSummaryLine(input.message ?? titleFallback);

  const deepLink =
    input.deepLink != null && String(input.deepLink).trim() !== ""
      ? String(input.deepLink).trim()
      : resolveInAppDeepLink({
          category,
          type,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          payload: input.payload ?? {},
        });

  const baseUrl = (config.frontendUrl || "https://suse7.com.br").replace(/\/+$/, "");
  const ctaHref = deepLink.startsWith("http")
    ? deepLink
    : `${baseUrl}${deepLink.startsWith("/") ? deepLink : `/${deepLink}`}`;

  const emoji = sandboxEmoji(category, type);
  const ctaLabel = String(input.ctaLabel ?? "Abra").trim();

  const lines = [`${emoji} Suse7`, "", summary, "", `${ctaLabel}:`, ctaHref];

  let messageText = lines.join("\n").trim();
  const charCount = messageText.length;
  const overIdeal = charCount > IDEAL_MAX_CHARS;

  if (charCount > HARD_MAX_CHARS) {
    messageText = `${messageText.slice(0, HARD_MAX_CHARS - 3)}...`;
  }

  return {
    message_text: messageText,
    logical_subject: headline,
    deep_link: deepLink,
    cta_href: ctaHref,
    char_count: messageText.length,
    over_ideal_length: overIdeal,
  };
}
