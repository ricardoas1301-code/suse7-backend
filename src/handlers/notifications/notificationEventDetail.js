// ============================================================
// GET /api/notifications/events/:id — detalhe + deliveries + logs (Fase 3)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  deriveNotificationEventStatus,
  summarizeDeliveries,
} from "../../domain/notifications/deriveNotificationEventStatus.js";
import {
  maskDeliveryDestination,
  sanitizeJsonForApi,
} from "../../domain/notifications/notificationHistorySanitize.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleNotificationEventDetail(req, res, path) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const id = String(path || "").match(/^\/api\/notifications\/events\/([^/]+)$/)?.[1] ?? "";
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ ok: false, error: "ID inválido" });
  }

  const { user, supabase } = auth;
  const uid = String(user.id);

  const { data: event, error: evErr } = await supabase
    .from("notification_events")
    .select("*")
    .eq("id", id)
    .eq("user_id", uid)
    .maybeSingle();

  if (evErr) {
    return res.status(500).json({ ok: false, error: evErr.message });
  }
  if (!event) {
    return res.status(404).json({ ok: false, error: "Evento não encontrado" });
  }

  let marketplace_account = null;
  if (event.marketplace_account_id) {
    const { data: acc } = await supabase
      .from("marketplace_accounts")
      .select("id, marketplace, external_seller_id, account_alias, ml_nickname, status, seller_company_id")
      .eq("id", event.marketplace_account_id)
      .eq("user_id", uid)
      .maybeSingle();
    marketplace_account = acc ?? null;
  }

  let seller_company = null;
  const scid =
    event.seller_company_id ??
    marketplace_account?.seller_company_id ??
    null;
  if (scid) {
    const { data: co } = await supabase
      .from("seller_companies")
      .select("id, company_name, trade_name, document_cnpj")
      .eq("id", scid)
      .eq("user_id", uid)
      .maybeSingle();
    seller_company = co ?? null;
  }

  const { data: deliveriesRaw, error: dErr } = await supabase
    .from("notification_deliveries")
    .select(
      "id, notification_event_id, user_id, contact_id, notification_channel, destination, provider, provider_message_id, status, attempts, manual_retry_count, last_attempt_at, next_retry_at, sent_at, delivered_at, failed_at, error_message, provider_response, created_at, updated_at"
    )
    .eq("notification_event_id", id)
    .eq("user_id", uid)
    .order("created_at", { ascending: true });

  if (dErr) {
    return res.status(500).json({ ok: false, error: dErr.message });
  }

  const deliveries = Array.isArray(deliveriesRaw) ? deliveriesRaw : [];
  const contactIds = [...new Set(deliveries.map((d) => d.contact_id).filter(Boolean).map(String))];
  /** @type {Record<string, { id: string, name?: string | null, role?: string | null }>} */
  const contactsById = {};
  if (contactIds.length > 0) {
    const { data: cRows } = await supabase
      .from("notification_contacts")
      .select("id, name, role")
      .eq("user_id", uid)
      .in("id", contactIds);
    for (const c of cRows ?? []) {
      contactsById[String(c.id)] = { id: String(c.id), name: c.name, role: c.role };
    }
  }
  const deliveryIds = deliveries.map((d) => String(d.id));

  /** @type {Record<string, unknown[]>} */
  const logsByDelivery = {};
  if (deliveryIds.length > 0) {
    const { data: logs } = await supabase
      .from("notification_delivery_logs")
      .select("id, notification_delivery_id, level, message, payload, created_at")
      .in("notification_delivery_id", deliveryIds)
      .order("created_at", { ascending: true });

    for (const log of logs ?? []) {
      const did = String(log.notification_delivery_id ?? "");
      if (!logsByDelivery[did]) logsByDelivery[did] = [];
      logsByDelivery[did].push({
        ...log,
        payload: sanitizeJsonForApi(log.payload),
      });
    }
  }

  const deliveriesOut = deliveries.map((d) => {
    const did = String(d.id);
    const ch = String(d.notification_channel ?? "");
    const cid = d.contact_id != null ? String(d.contact_id) : "";
    return {
      ...d,
      destination_masked: maskDeliveryDestination(d.destination, ch),
      destination: undefined,
      provider_response: sanitizeJsonForApi(d.provider_response),
      contact: cid ? contactsById[cid] ?? null : null,
      logs: logsByDelivery[did] ?? [],
    };
  });

  const summary = summarizeDeliveries(deliveries);
  const derived_status = deriveNotificationEventStatus(deliveries);

  return res.status(200).json({
    ok: true,
    event: {
      ...event,
      payload: sanitizeJsonForApi(event.payload),
    },
    marketplace_account,
    seller_company,
    summary,
    derived_status,
    deliveries: deliveriesOut,
  });
}
