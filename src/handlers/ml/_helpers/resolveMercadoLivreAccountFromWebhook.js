import { asMlWebhookObject, extractMlWebhookMeta } from "./mlWebhookPayload.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {unknown} payload
 */
export async function resolveMercadoLivreAccountFromWebhook(supabase, payload) {
  const meta = extractMlWebhookMeta(payload);
  const o = asMlWebhookObject(payload);
  const marketplaceUserId = meta.marketplaceUserId;
  const candidateAccountId =
    o.marketplace_account_id != null ? String(o.marketplace_account_id).trim() : "";

  if (candidateAccountId) {
    const { data } = await supabase
      .from("marketplace_accounts")
      .select("id")
      .eq("id", candidateAccountId)
      .eq("marketplace", "mercado_livre")
      .maybeSingle();
    if (data?.id) {
      return {
        resolved: true,
        marketplace_account_id: String(data.id),
        warning: null,
      };
    }
  }

  if (marketplaceUserId) {
    const { data } = await supabase
      .from("marketplace_accounts")
      .select("id")
      .eq("marketplace", "mercado_livre")
      .eq("external_seller_id", marketplaceUserId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      return {
        resolved: true,
        marketplace_account_id: String(data.id),
        warning: null,
      };
    }
  }

  return {
    resolved: false,
    marketplace_account_id: null,
    warning: "marketplace_account_unresolved",
  };
}

