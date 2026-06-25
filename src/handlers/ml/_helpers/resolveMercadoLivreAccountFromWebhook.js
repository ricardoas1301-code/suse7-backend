import { asMlWebhookObject, extractMlWebhookMeta } from "./mlWebhookPayload.js";

function pickOrderIdFromResource(resource) {
  if (resource == null) return null;
  const parts = String(resource)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const tail = parts[parts.length - 1] || null;
  return tail && /^\d+$/.test(tail) ? tail : tail;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {unknown} payload
 */
export async function resolveMercadoLivreAccountFromWebhook(supabase, payload) {
  try {
  const meta = extractMlWebhookMeta(payload);
  const o = asMlWebhookObject(payload);
  const topic = meta.topic != null ? String(meta.topic).toLowerCase() : null;
  const resource = meta.resource != null ? String(meta.resource) : null;
  const orderId = pickOrderIdFromResource(resource);
  const sellerIdFromPayload = meta.marketplaceUserId != null ? String(meta.marketplaceUserId) : null;
  const marketplaceUserId = meta.marketplaceUserId;
  const candidateAccountId =
    o.marketplace_account_id != null ? String(o.marketplace_account_id).trim() : "";
  console.info("[WEBHOOK_CONTEXT_RESOLVE_START]", {
    stage: "ingest",
    topic,
    resource,
    order_id: orderId,
    user_id: meta.marketplaceUserId ?? null,
    application_id: meta.applicationId ?? null,
    marketplace: "mercado_livre",
    marketplace_user_id: marketplaceUserId ?? null,
    marketplace_account_id: candidateAccountId || null,
    seller_id_from_payload: sellerIdFromPayload,
    seller_id_from_resource: orderId,
  });
  console.info("[WEBHOOK_CONTEXT_RESOLVE_PAYLOAD]", {
    topic,
    resource,
    user_id: meta.marketplaceUserId ?? null,
    application_id: meta.applicationId ?? null,
    marketplace_user_id: marketplaceUserId ?? null,
    marketplace_account_id: candidateAccountId || null,
    payload_keys: Object.keys(o || {}).slice(0, 60),
  });

  if (candidateAccountId) {
    console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_ATTEMPT]", {
      stage: "ingest",
      attempt: "candidate_marketplace_account_id",
      marketplace_account_id: candidateAccountId,
    });
    const { data } = await supabase
      .from("marketplace_accounts")
      .select("id,user_id,seller_company_id,external_seller_id")
      .eq("id", candidateAccountId)
      .eq("marketplace", "mercado_livre")
      .maybeSingle();
    if (data?.id) {
      console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_FOUND]", {
        stage: "ingest",
        attempt: "candidate_marketplace_account_id",
        matches_found_count: 1,
        candidate_marketplace_accounts: [data],
      });
      return {
        resolved: true,
        marketplace_account_id: String(data.id),
        warning: null,
      };
    }
  }

  if (marketplaceUserId) {
    console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_ATTEMPT]", {
      stage: "ingest",
      attempt: "external_seller_id_from_payload",
      external_seller_id: marketplaceUserId,
    });
    const { data: rows } = await supabase
      .from("marketplace_accounts")
      .select("id,user_id,seller_company_id,external_seller_id")
      .eq("marketplace", "mercado_livre")
      .eq("external_seller_id", marketplaceUserId)
      .neq("status", "removed")
      .order("updated_at", { ascending: false })
      .limit(5);
    const candidates = Array.isArray(rows) ? rows : [];
    if (candidates.length > 0) {
      console.info("[WEBHOOK_CONTEXT_RESOLVE_MATCH_FOUND]", {
        stage: "ingest",
        attempt: "external_seller_id_from_payload",
        matches_found_count: candidates.length,
        candidate_marketplace_accounts: candidates,
      });
      return {
        resolved: true,
        marketplace_account_id: String(candidates[0].id),
        warning: null,
      };
    }
  }

  console.warn("[WEBHOOK_CONTEXT_RESOLVE_NOT_FOUND]", {
    stage: "ingest",
    topic,
    resource,
    order_id: orderId,
    user_id: meta.marketplaceUserId ?? null,
    application_id: meta.applicationId ?? null,
    marketplace: "mercado_livre",
    marketplace_user_id: marketplaceUserId ?? null,
    marketplace_account_id: candidateAccountId || null,
    seller_id_from_payload: sellerIdFromPayload,
    seller_id_from_resource: orderId,
    matches_found_count: 0,
    candidate_marketplace_accounts: [],
  });

  return {
    resolved: false,
    marketplace_account_id: null,
    warning: "marketplace_account_unresolved",
  };
  } catch (e) {
    console.error("[WEBHOOK_CONTEXT_RESOLVE_FAILED]", {
      stage: "ingest",
      message: e?.message ? String(e.message) : String(e),
    });
    return {
      resolved: false,
      marketplace_account_id: null,
      warning: "marketplace_account_unresolved",
    };
  }
}

