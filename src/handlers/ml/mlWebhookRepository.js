import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import {
  buildMlWebhookDedupeKey,
  extractMlWebhookMeta,
  inferOrderIdFromMlWebhook,
  inferShipmentIdFromMlWebhook,
} from "./_helpers/mlWebhookPayload.js";

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
 * Persistência idempotente mínima — insert-first (1 RTT no caminho feliz).
 * Resolução de conta deferida ao processor (fora do ACK).
 *
 * @param {unknown} payload
 * @param {{ ip: string | null; marketplace?: string }} opts
 */
export async function saveMlWebhookEvent(payload, opts) {
  const timing = { db_start_ms: Date.now() };
  const supabase = getSupabaseAdmin();
  const marketplace = opts.marketplace || "mercado_livre";
  const meta = extractMlWebhookMeta(payload);
  const dedupeKey = buildMlWebhookDedupeKey(payload);

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
    marketplace_account_id: null,
    error_message: null,
  };

  const { data: inserted, error } = await supabase
    .from("ml_webhook_events")
    .insert(row)
    .select("id, status")
    .maybeSingle();
  timing.dedupe_done_ms = Date.now();

  if (!error && inserted?.id) {
    timing.db_done_ms = timing.dedupe_done_ms;
    console.info("[ml-webhook] event_queued", {
      id: String(inserted.id),
      duplicate: false,
      status: String(inserted.status || "pending"),
      topic: meta.topic,
      resource: meta.resource,
      user_id: meta.marketplaceUserId,
      ml_user_id: meta.marketplaceUserId,
      order_id: inferOrderIdFromMlWebhook(meta.topic, meta.resource),
      shipment_id: inferShipmentIdFromMlWebhook(meta.topic, meta.resource),
      marketplace_account_id: null,
    });
    return {
      saved: true,
      duplicate: false,
      id: String(inserted.id),
      status: String(inserted.status || "pending"),
      topic: meta.topic,
      resource: meta.resource,
      user_id: meta.marketplaceUserId,
      timing,
    };
  }

  if (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === "23505") {
      const { data: existing } = await supabase
        .from("ml_webhook_events")
        .select("id, status")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();
      timing.db_done_ms = Date.now();
      console.info("[ml-webhook] event_queued", {
        id: existing?.id != null ? String(existing.id) : null,
        duplicate: true,
        status: String(existing?.status || "pending"),
        topic: meta.topic,
        resource: meta.resource,
        user_id: meta.marketplaceUserId,
        ml_user_id: meta.marketplaceUserId,
        order_id: inferOrderIdFromMlWebhook(meta.topic, meta.resource),
        shipment_id: inferShipmentIdFromMlWebhook(meta.topic, meta.resource),
      });
      return {
        saved: true,
        duplicate: true,
        id: existing?.id != null ? String(existing.id) : null,
        status: String(existing?.status || "pending"),
        topic: meta.topic,
        resource: meta.resource,
        user_id: meta.marketplaceUserId,
        timing,
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

  timing.db_done_ms = Date.now();
  throw new Error("ML_WEBHOOK_INSERT_UNEXPECTED_EMPTY");
}
