// ============================================================
// Produtor real — conta marketplace ML desconectada / token inválido
// Não deve derrubar fluxo principal; falhas apenas warning em log.
// ============================================================

import { ingestNotificationEvent } from "../notificationPipeline.js";

function normalizeReason(reason) {
  const s = reason != null ? String(reason).trim().toLowerCase() : "unknown";
  return s.replace(/\s+/g, "_").slice(0, 80) || "unknown";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string,
 *   marketplaceAccountId?: string | null,
 *   marketplace?: string,
 *   reason: string,
 *   source?: string,
 * }} args
 */
export async function notifyMarketplaceAccountDisconnected(args) {
  const supabase = args.supabase;
  const userId = String(args.userId ?? "").trim();
  if (!userId || !supabase) return { ok: false, error: "MISSING_USER_OR_DB" };

  const marketplace = args.marketplace != null ? String(args.marketplace).trim() : "mercado_livre";
  let mid =
    args.marketplaceAccountId != null && String(args.marketplaceAccountId).trim() !== ""
      ? String(args.marketplaceAccountId).trim()
      : null;

  try {
    if (!mid) {
      const { data } = await supabase
        .from("marketplace_accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("marketplace", marketplace)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      mid = data?.id != null ? String(data.id) : null;
    }

    const reasonNorm = normalizeReason(args.reason);
    const source = args.source != null ? String(args.source).slice(0, 60) : "unknown";

    console.warn("[S7_NOTIFICATION_PRODUCER_ACCOUNT_DISCONNECTED]", {
      user_id: userId,
      marketplace_account_id: mid,
      marketplace,
      reason: reasonNorm,
      source,
    });

    return await ingestNotificationEvent(supabase, {
      userId,
      notificationType: "conta_desconectada",
      title: "Conta Mercado Livre desconectada",
      message:
        "A integração com esta conta precisa ser reconectada para manter o monitoramento ativo.",
      marketplace,
      marketplaceAccountId: mid,
      entityType: "marketplace_account",
      entityId: mid,
      eventSeverity: "important",
      relevanceKey: `${source}:${reasonNorm}`,
      payload: {
        source,
        reason_code: reasonNorm,
        marketplace,
      },
    });
  } catch (err) {
    console.warn("[S7_NOTIFICATION_PRODUCER_ACCOUNT_DISCONNECTED_FAIL]", {
      user_id: userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: err instanceof Error ? err.message : "producer_failed" };
  }
}
