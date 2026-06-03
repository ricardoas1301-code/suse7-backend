// =============================================================================
// Persistência append-only — s7_notification_events
//
// Duas proteções independentes (Fase S5.1):
//   - idempotência: replay exato por (seller_id, idempotency_key). JÁ EXISTIA.
//   - dedupe por janela: conteúdo equivalente (dedupe_key) num intervalo curto.
// =============================================================================

import { logCentralNotification } from "../observability/centralNotificationLog.js";

/**
 * Procura um evento equivalente recente dentro da janela de dedupe.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ sellerId: string; dedupeKey: string; windowSeconds: number }} input
 * @returns {Promise<{ hit: boolean; event?: Record<string, unknown> }>}
 */
async function findRecentDedupeEvent(supabase, input) {
  const sinceIso = new Date(Date.now() - input.windowSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from("s7_notification_events")
    .select("*")
    .eq("seller_id", input.sellerId)
    .eq("dedupe_key", input.dedupeKey)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Falha de lookup não pode bloquear a publicação — apenas registra e segue.
    logCentralNotification("EVENT_DEDUPE_LOOKUP_ERR", { message: error.message });
    return { hit: false };
  }
  if (data) return { hit: true, event: data };
  return { hit: false };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   category: string;
 *   type: string;
 *   severity?: string;
 *   payload?: Record<string, unknown>;
 *   correlationId?: string | null;
 *   idempotencyKey: string;
 *   contractVersion?: number | null;
 *   metadata?: Record<string, unknown> | null;
 *   dedupeKey?: string | null;
 *   dedupeWindowSeconds?: number | null;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   sourceModule?: string | null;
 * }} input
 */
export async function insertCentralNotificationEvent(supabase, input) {
  // 1. Idempotência exata (replay com a mesma chave).
  const { data: existing, error: findErr } = await supabase
    .from("s7_notification_events")
    .select("*")
    .eq("seller_id", input.sellerId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();

  if (findErr) {
    logCentralNotification("EVENT_INSERT_LOOKUP_ERR", { message: findErr.message });
    return { ok: false, error: findErr.message };
  }

  if (existing) {
    logCentralNotification("EVENT_IDEMPOTENT_HIT", {
      event_id: existing.id,
      seller_id: input.sellerId,
      idempotency_key: input.idempotencyKey,
    });
    return { ok: true, event: existing, idempotent: true, deduped: false };
  }

  // 2. Dedupe por janela (conteúdo equivalente em curto intervalo).
  const dedupeKey =
    input.dedupeKey != null && String(input.dedupeKey).trim() !== ""
      ? String(input.dedupeKey).trim()
      : null;
  const windowSeconds = Number(input.dedupeWindowSeconds) || 0;

  if (dedupeKey && windowSeconds > 0) {
    const dedupe = await findRecentDedupeEvent(supabase, {
      sellerId: input.sellerId,
      dedupeKey,
      windowSeconds,
    });
    if (dedupe.hit && dedupe.event) {
      logCentralNotification("EVENT_DEDUPE_WINDOW_HIT", {
        event_id: dedupe.event.id,
        seller_id: input.sellerId,
        dedupe_key: dedupeKey,
        dedupe_window_seconds: windowSeconds,
      });
      return { ok: true, event: dedupe.event, idempotent: false, deduped: true };
    }
  }

  // 3. Persistência append-only.
  const { data, error } = await supabase
    .from("s7_notification_events")
    .insert({
      seller_id: input.sellerId,
      category_code: input.category,
      type_key: input.type,
      severity: input.severity ?? "info",
      payload: input.payload ?? {},
      correlation_id: input.correlationId ?? null,
      idempotency_key: input.idempotencyKey,
      contract_version: input.contractVersion ?? 1,
      metadata: input.metadata ?? {},
      dedupe_key: dedupeKey,
      dedupe_window_seconds: dedupeKey ? windowSeconds : null,
      marketplace: input.marketplace ?? null,
      marketplace_account_id: input.marketplaceAccountId ?? null,
      seller_company_id: input.sellerCompanyId ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      source_module: input.sourceModule ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: race } = await supabase
        .from("s7_notification_events")
        .select("*")
        .eq("seller_id", input.sellerId)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (race) {
        return { ok: true, event: race, idempotent: true, deduped: false };
      }
    }
    logCentralNotification("EVENT_INSERT_FAILED", { message: error.message });
    return { ok: false, error: error.message };
  }

  logCentralNotification("EVENT_PUBLISHED", {
    event_id: data?.id,
    seller_id: input.sellerId,
    category: input.category,
    type: input.type,
    correlation_id: input.correlationId,
    contract_version: input.contractVersion ?? 1,
    dedupe_key: dedupeKey,
  });

  return { ok: true, event: data, idempotent: false, deduped: false };
}
