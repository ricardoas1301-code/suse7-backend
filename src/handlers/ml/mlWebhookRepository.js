import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { buildMlWebhookDedupeKey, extractMlWebhookMeta } from "./_helpers/mlWebhookPayload.js";
import { resolveMercadoLivreAccountFromWebhook } from "./_helpers/resolveMercadoLivreAccountFromWebhook.js";

/**
 * @returns {import("@supabase/supabase-js").SupabaseClient}
 */
function getSupabaseAdmin() {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * @param {unknown} payload
 * @param {{ ip: string | null; marketplace?: string }} opts
 */
export async function saveMlWebhookEvent(payload, opts) {
  const supabase = getSupabaseAdmin();
  const marketplace = opts.marketplace || "mercado_livre";
  const meta = extractMlWebhookMeta(payload);
  const dedupeKey = buildMlWebhookDedupeKey(payload);
  const resolved = await resolveMercadoLivreAccountFromWebhook(supabase, payload);

  const row = {
    marketplace,
    topic: meta.topic,
    resource: meta.resource,
    user_id: meta.marketplaceUserId,
    marketplace_user_id: meta.marketplaceUserId,
    application_id: meta.applicationId,
    payload,
    raw_payload: payload,
    source_ip: opts.ip,
    dedupe_key: dedupeKey,
    external_event_id: meta.externalEventId,
    status: resolved.resolved ? "pending" : "error",
    marketplace_account_id: resolved.marketplace_account_id,
  };

  const { data: existing } = await supabase
    .from("ml_webhook_events")
    .select("id, status")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (existing?.id) {
    return {
      saved: true,
      duplicate: true,
      id: String(existing.id),
      status: String(existing.status || "pending"),
      topic: meta.topic,
      resource: meta.resource,
      user_id: meta.marketplaceUserId,
    };
  }

  const { data: inserted, error } = await supabase
    .from("ml_webhook_events")
    .insert(row)
    .select("id, status")
    .maybeSingle();

  if (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === "23505") {
      return {
        saved: true,
        duplicate: true,
        id: null,
        status: "pending",
        topic: meta.topic,
        resource: meta.resource,
        user_id: meta.marketplaceUserId,
      };
    }
    throw error;
  }

  return {
    saved: true,
    duplicate: false,
    id: inserted?.id != null ? String(inserted.id) : null,
    status: inserted?.status != null ? String(inserted.status) : row.status,
    topic: meta.topic,
    resource: meta.resource,
    user_id: meta.marketplaceUserId,
  };
}
