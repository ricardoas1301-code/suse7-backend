// ============================================================
// POST /api/notifications/deliveries/:id/cancel — cancelar (Fase 3)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { cancelNotificationDelivery } from "../../domain/notifications/cancelNotificationDelivery.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleNotificationDeliveryCancel(req, res, path) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const id = String(path || "").match(/^\/api\/notifications\/deliveries\/([^/]+)\/cancel$/)?.[1] ?? "";
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: "ID inválido" });
  }

  const { user, supabase } = auth;
  const uid = String(user.id);

  const { data: row, error: loadErr } = await supabase
    .from("notification_deliveries")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();

  if (loadErr) {
    return res.status(500).json({ ok: false, error: loadErr.message });
  }
  if (!row || String(row.user_id) !== uid) {
    return res.status(404).json({ ok: false, error: "Delivery não encontrada" });
  }

  const status = String(row.status ?? "").toLowerCase();
  if (!["pending", "processing"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Somente pending ou processing podem ser cancelados." });
  }

  const result = await cancelNotificationDelivery(supabase, id, "Cancelado pelo usuário (painel histórico).", {
    logMessage: "manual_cancel_requested",
  });

  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error ?? "Não foi possível cancelar." });
  }

  return res.status(200).json({ ok: true, delivery_id: id });
}
