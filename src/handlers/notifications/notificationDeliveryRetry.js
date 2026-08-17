// ============================================================
// POST /api/notifications/deliveries/:id/retry — reprocessar (Fase 3)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { appendNotificationDeliveryLog } from "../../domain/notifications/deliveryAuditLog.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANUAL_RETRY = 5;

export async function handleNotificationDeliveryRetry(req, res, path) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const id = String(path || "").match(/^\/api\/notifications\/deliveries\/([^/]+)\/retry$/)?.[1] ?? "";
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: "ID inválido" });
  }

  const { user, supabase } = auth;
  const uid = String(user.id);

  const { data: row, error: loadErr } = await supabase
    .from("notification_deliveries")
    .select("id, user_id, status, attempts, manual_retry_count")
    .eq("id", id)
    .maybeSingle();

  if (loadErr) {
    return res.status(500).json({ ok: false, error: loadErr.message });
  }
  if (!row || String(row.user_id) !== uid) {
    return res.status(404).json({ ok: false, error: "Delivery não encontrada" });
  }

  const status = String(row.status ?? "").toLowerCase();
  const allowed = ["failed", "pending", "processing"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ ok: false, error: "Status não permite reprocessamento manual." });
  }

  const manual = Number(row.manual_retry_count ?? 0);
  if (manual >= MAX_MANUAL_RETRY) {
    return res.status(400).json({
      ok: false,
      error: `Limite de reprocessamentos manuais atingido (${MAX_MANUAL_RETRY}).`,
    });
  }

  await appendNotificationDeliveryLog(supabase, id, "info", "manual_retry_requested", {
    previous_status: status,
    previous_attempts: row.attempts,
  });

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("notification_deliveries")
    .update({
      status: "pending",
      next_retry_at: nowIso,
      attempts: 0,
      error_message: null,
      manual_retry_count: manual + 1,
      updated_at: nowIso,
    })
    .eq("id", id)
    .eq("user_id", uid);

  if (updErr) {
    return res.status(500).json({ ok: false, error: updErr.message });
  }

  return res.status(200).json({ ok: true, delivery_id: id, manual_retry_count: manual + 1 });
}
