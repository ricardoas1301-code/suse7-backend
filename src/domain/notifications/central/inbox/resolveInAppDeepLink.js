// =============================================================================
// Deep links do inbox in-app — navegação seller-first
// =============================================================================

/**
 * @param {{
 *   category?: string | null;
 *   type?: string | null;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   payload?: Record<string, unknown>;
 * }} input
 */
export function resolveInAppDeepLink(input) {
  const category = String(input.category ?? "").trim().toUpperCase();
  const type = String(input.type ?? "").trim().toUpperCase();
  const entityId =
    input.entityId != null && String(input.entityId).trim() !== ""
      ? String(input.entityId).trim()
      : null;
  const payloadDeep =
    input.payload?.deep_link != null ? String(input.payload.deep_link).trim() : "";
  if (payloadDeep.startsWith("/")) return payloadDeep;

  if (category === "BILLING") {
    if (
      ["PAYMENT_CONFIRMED", "PAYMENT_GENERATED", "RENEWAL_COMPLETED", "PAYMENT_FAILED"].includes(type)
    ) {
      return "/perfil/assinatura/historico";
    }
    return "/perfil/assinatura/minha-assinatura";
  }

  if (category === "PROFIT" || category === "SALES") {
    if (entityId) return `/vendas?sale=${encodeURIComponent(entityId)}`;
    return "/vendas";
  }

  if (category === "PRODUCTS" || category === "INVENTORY") {
    if (entityId) return `/produtos/${encodeURIComponent(entityId)}/editar`;
    return "/produtos";
  }

  if (category === "ACCOUNT_HEALTH" || category === "MARKETPLACE") {
    return "/perfil/integracoes/mercado-livre";
  }

  if (category === "COMPETITION") return "/concorrencia";
  if (category === "SYNC" || category === "SYSTEM" || category === "DEVCENTER") {
    return "/notificacoes";
  }

  return "/notificacoes";
}
