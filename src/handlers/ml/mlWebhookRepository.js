import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { buildMlWebhookDedupeKey, extractMlWebhookMeta, inferOrderIdFromMlWebhook, inferShipmentIdFromMlWebhook } from "./_helpers/mlWebhookPayload.js";
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
 * @param {unknown} error
 */
function parseMissingColumnsFromSchemaError(error) {
  const text = [
    /** @type {{ message?: string }} */ (error)?.message ?? "",
    /** @type {{ details?: string }} */ (error)?.details ?? "",
    /** @type {{ hint?: string }} */ (error)?.hint ?? "",
  ]
    .map((s) => String(s || ""))
    .join(" | ");
  if (!text) return [];
  const out = new Set();
  const quoted = [...text.matchAll(/'([^']+)'/g)];
  for (const m of quoted) {
    const token = String(m?.[1] || "").trim();
    if (/^[a-z_][a-z0-9_]*$/i.test(token)) out.add(token);
  }
  return [...out];
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
    status: "pending",
    marketplace_account_id: resolved.marketplace_account_id,
    error_message: resolved.resolved ? null : resolved.warning,
  };

  const { data: existing } = await supabase
    .from("ml_webhook_events")
    .select("id, status")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (existing?.id) {
    console.info("[ml-webhook] event_queued", {
      id: String(existing.id),
      duplicate: true,
      status: String(existing.status || "pending"),
      topic: meta.topic,
      resource: meta.resource,
      user_id: meta.marketplaceUserId,
      ml_user_id: meta.marketplaceUserId,
      order_id: inferOrderIdFromMlWebhook(meta.topic, meta.resource),
      shipment_id: inferShipmentIdFromMlWebhook(meta.topic, meta.resource),
      marketplace_account_id: resolved.marketplace_account_id ?? null,
    });
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
      console.info("[ml-webhook] event_queued", {
        duplicate: true,
        status: "pending",
        topic: meta.topic,
        resource: meta.resource,
        user_id: meta.marketplaceUserId,
        ml_user_id: meta.marketplaceUserId,
        order_id: inferOrderIdFromMlWebhook(meta.topic, meta.resource),
        shipment_id: inferShipmentIdFromMlWebhook(meta.topic, meta.resource),
        marketplace_account_id: resolved.marketplace_account_id ?? null,
      });
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
    const schemaError =
      String(code || "").toUpperCase() === "PGRST204" ||
      String(code || "") === "42703" ||
      String(error?.message || "").toLowerCase().includes("schema cache") ||
      String(error?.message || "").toLowerCase().includes("could not find the") ||
      String(error?.message || "").toLowerCase().includes("column");
    if (schemaError) {
      const missingColumns = parseMissingColumnsFromSchemaError(error);
      console.error("[ML_WEBHOOK_EVENT_INSERT_FAILED_SCHEMA]", {
        code: code ?? null,
        message: error?.message ?? null,
        details: error?.details ?? null,
        hint: error?.hint ?? null,
        missing_columns: missingColumns,
        attempted_columns: Object.keys(row),
      });
    }
    throw error;
  }

  console.info("[ml-webhook] event_queued", {
    id: inserted?.id != null ? String(inserted.id) : null,
    duplicate: false,
    status: inserted?.status != null ? String(inserted.status) : row.status,
    topic: meta.topic,
    resource: meta.resource,
    user_id: meta.marketplaceUserId,
    ml_user_id: meta.marketplaceUserId,
    order_id: inferOrderIdFromMlWebhook(meta.topic, meta.resource),
    shipment_id: inferShipmentIdFromMlWebhook(meta.topic, meta.resource),
    marketplace_account_id: resolved.marketplace_account_id ?? null,
  });

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
