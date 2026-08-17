// ============================================================
// Worker — processa lote de notification_deliveries (Fase 2)
// Reclaim de linhas presas em processing + picks pending respeitando next_retry_at
// ============================================================

import { NOTIFICATION_DELIVERY_MAX_ATTEMPTS } from "../../domain/notifications/retrySchedule.js";
import { processNotificationDelivery } from "../../domain/notifications/processNotificationDelivery.js";
import { appendNotificationDeliveryLog } from "../../domain/notifications/deliveryAuditLog.js";
import { logNotification } from "../../domain/notifications/notificationLog.js";

const DEFAULT_BATCH = 50;
const STALE_PROCESSING_MS = 15 * 60 * 1000;

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ batchSize?: number }} [opts]
 */
export async function runNotificationDeliveriesWorkerTick(supabase, opts = {}) {
  const batchSize = Math.min(200, Math.max(1, Number(opts.batchSize) || DEFAULT_BATCH));
  const now = new Date();
  const nowIso = now.toISOString();
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();

  const { error: reclaimErr, data: reclaimed } = await supabase
    .from("notification_deliveries")
    .update({
      status: "pending",
      error_message: "reclaimed_stale_processing",
      updated_at: nowIso,
    })
    .eq("status", "processing")
    .lt("last_attempt_at", staleCutoff)
    .select("id");

  if (reclaimErr) {
    console.error("[S7_NOTIFICATION_WORKER_RECLAIM_ERR]", { message: reclaimErr.message });
  } else if (Array.isArray(reclaimed) && reclaimed.length > 0) {
    logNotification("WORKER_RECLAIM", { count: reclaimed.length });
  }

  const { data: candidates, error: pickErr } = await supabase
    .from("notification_deliveries")
    .select("id, attempts, status, next_retry_at")
    .eq("status", "pending")
    .lt("attempts", NOTIFICATION_DELIVERY_MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (pickErr) {
    console.error("[S7_NOTIFICATION_WORKER_PICK_ERR]", { message: pickErr.message });
    return { ok: false, error: pickErr.message, processed: 0 };
  }

  const rows = Array.isArray(candidates) ? candidates : [];
  let processed = 0;

  for (const row of rows) {
    const nid = String(row.id ?? "");
    if (!nid) continue;

    const retryOk =
      row.next_retry_at == null || String(row.next_retry_at).trim() === "" || row.next_retry_at <= nowIso;

    if (!retryOk) continue;

    const { data: locked, error: lockErr } = await supabase
      .from("notification_deliveries")
      .update({
        status: "processing",
        attempts: Number(row.attempts ?? 0) + 1,
        last_attempt_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", nid)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();

    if (lockErr || !locked) continue;

    await appendNotificationDeliveryLog(supabase, nid, "info", "worker_pickup", {
      attempts: locked.attempts,
    });

    try {
      await processNotificationDelivery(supabase, nid);
      processed++;
    } catch (err) {
      console.error("[S7_NOTIFICATION_WORKER_ITEM_ERR]", {
        delivery_id: nid,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logNotification("WORKER_TICK_COMPLETE", { processed, picked: rows.length });
  return { ok: true, processed };
}
