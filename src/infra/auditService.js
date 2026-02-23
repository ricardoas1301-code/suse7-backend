// ======================================================================
// SUSE7 — Audit Service
// Registra alterações em entidades para auditoria
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

/**
 * Grava evento de auditoria.
 * @param {{
 *   userId: string;
 *   entityType: string;
 *   entityId: string;
 *   action: "create" | "update";
 *   diff: object;
 *   traceId?: string | null;
 * }} params
 * @returns {Promise<{ id?: string; error?: Error }>}
 */
export async function recordAuditEvent({
  userId,
  entityType,
  entityId,
  action,
  diff,
  traceId = null,
}) {
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from("audit_events")
    .insert({
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      diff_json: diff,
      trace_id: traceId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[auditService] recordAuditEvent fail:", error);
    return { error };
  }

  return { id: data?.id };
}
