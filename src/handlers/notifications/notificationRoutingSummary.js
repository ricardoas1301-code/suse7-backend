// ============================================================
// GET /api/notifications/routing-summary — agregado por tipo (Fase 3)
// Alimenta badges nos cards de Preferências > Notificações.
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";

export async function handleNotificationRoutingSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const uid = String(user.id);

  const { data: rows, error } = await supabase
    .from("notification_routing_rules")
    .select("notification_type, notification_channel, contact_id, marketplace_account_id")
    .eq("user_id", uid)
    .eq("active", true);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  /** @type {Record<string, { whatsapp: Set<string>, email: Set<string>, accounts: Set<string>, has_rules: boolean }>} */
  const map = {};

  for (const r of rows ?? []) {
    const t = String(r.notification_type ?? "").trim();
    if (!t) continue;
    if (!map[t]) {
      map[t] = {
        whatsapp: new Set(),
        email: new Set(),
        accounts: new Set(),
        has_rules: false,
      };
    }
    map[t].has_rules = true;

    const ch = String(r.notification_channel ?? "").trim();
    const cid = r.contact_id != null ? String(r.contact_id) : "";
    const aid = r.marketplace_account_id != null ? String(r.marketplace_account_id) : "";

    if (ch === "whatsapp" && cid) map[t].whatsapp.add(cid);
    if (ch === "email" && cid) map[t].email.add(cid);
    if (aid) map[t].accounts.add(aid);
  }

  /** @type {Record<string, unknown>} */
  const summary = {};
  for (const [k, v] of Object.entries(map)) {
    summary[k] = {
      whatsapp_contacts_count: v.whatsapp.size,
      email_contacts_count: v.email.size,
      marketplace_accounts_count: v.accounts.size,
      has_rules: v.has_rules,
    };
  }

  return res.status(200).json({ ok: true, summary });
}
