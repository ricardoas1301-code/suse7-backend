// ============================================================
// GET /api/notifications/debug/resolve — diagnóstico de roteamento (Fase 2)
// Ambiente: NODE_ENV=development OU e-mail na allowlist Dev Center (JWT).
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { resolveDevCenterAccess } from "../devCenter/devCenterAccess.js";
import {
  NOTIFICATION_ROUTING_CHANNELS,
  isValidRoutingChannel,
  isValidRoutingNotificationType,
} from "../../domain/notificationRoutingCatalog.js";
import { resolveNotificationRecipients } from "../../domain/notificationRecipientsResolver.js";

async function explainIgnoredContacts(supabase, userId, routingType, channel, marketplaceAccountId) {
  const mid =
    marketplaceAccountId != null && String(marketplaceAccountId).trim() !== ""
      ? String(marketplaceAccountId).trim()
      : null;

  const { data: rules } = await supabase
    .from("notification_routing_rules")
    .select("id, contact_id, marketplace_account_id, active")
    .eq("user_id", userId)
    .eq("notification_type", routingType)
    .eq("notification_channel", channel)
    .eq("active", true);

  const ruleRows = Array.isArray(rules) ? rules : [];
  const contactIds = [
    ...new Set(ruleRows.map((r) => r.contact_id).filter((id) => id != null && String(id).trim() !== "")),
  ];

  if (contactIds.length === 0) {
    return [];
  }

  const { data: contacts } = await supabase
    .from("notification_contacts")
    .select("id, name, active, whatsapp, email")
    .eq("user_id", userId)
    .in("id", contactIds);

  const byId = new Map((contacts ?? []).map((c) => [String(c.id), c]));
  const resolved = await resolveNotificationRecipients(supabase, {
    userId,
    notificationType: routingType,
    marketplaceAccountId: mid,
    channel,
  });

  const resolvedIds = new Set((resolved.contacts_resolved ?? []).map((c) => String(c.id)));

  /** @type {Array<{ contact_id: string, reason: string }>} */
  const ignored = [];

  for (const cid of contactIds) {
    const cs = String(cid);
    if (resolvedIds.has(cs)) continue;

    const row = byId.get(cs);
    if (!row) {
      ignored.push({ contact_id: cs, reason: "contact_not_found_or_other_user" });
      continue;
    }
    if (row.active === false) {
      ignored.push({ contact_id: cs, reason: "contact_inactive" });
      continue;
    }
    if (channel === NOTIFICATION_ROUTING_CHANNELS.whatsapp && !String(row.whatsapp ?? "").replace(/\D/g, "")) {
      ignored.push({ contact_id: cs, reason: "missing_whatsapp" });
      continue;
    }
    if (channel === NOTIFICATION_ROUTING_CHANNELS.email && !String(row.email ?? "").trim()) {
      ignored.push({ contact_id: cs, reason: "missing_email" });
      continue;
    }

    const ra = ruleRows.find((r) => r.contact_id != null && String(r.contact_id) === cs);
    const racct = ra?.marketplace_account_id != null ? String(ra.marketplace_account_id) : "";
    if (mid && racct && racct !== mid) {
      ignored.push({ contact_id: cs, reason: "marketplace_account_scope_mismatch" });
      continue;
    }

    ignored.push({ contact_id: cs, reason: "filtered_by_resolver_rules" });
  }

  return ignored;
}

export async function handleNotificationsDebugResolve(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const nodeEnv = process.env.NODE_ENV ?? "";
  const allowDev = nodeEnv === "development";
  const access = await resolveDevCenterAccess(auth.supabase, auth.user);
  const allowOps = access.allowed;

  if (!allowDev && !allowOps) {
    return res.status(403).json({ ok: false, error: "Acesso negado (somente DEV ou Dev Center)." });
  }

  const notificationType =
    req.query?.notification_type != null ? String(req.query.notification_type).trim() : "";
  const marketplaceAccountId =
    req.query?.marketplace_account_id != null ? String(req.query.marketplace_account_id).trim() : "";
  const channelRaw = req.query?.channel != null ? String(req.query.channel).trim() : "";

  if (!isValidRoutingNotificationType(notificationType)) {
    return res.status(400).json({ ok: false, error: "notification_type inválido ou ausente" });
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const userId = String(auth.user.id);

  const channels =
    channelRaw && isValidRoutingChannel(channelRaw)
      ? [channelRaw]
      : [NOTIFICATION_ROUTING_CHANNELS.app, NOTIFICATION_ROUTING_CHANNELS.email, NOTIFICATION_ROUTING_CHANNELS.whatsapp];

  /** @type {Record<string, unknown>} */
  const out = { ok: true, user_id: userId, notification_type: notificationType, channels: {} };

  for (const ch of channels) {
    const resolved = await resolveNotificationRecipients(supabase, {
      userId,
      notificationType,
      marketplaceAccountId: marketplaceAccountId || null,
      channel: ch,
    });

    const ignored =
      ch === NOTIFICATION_ROUTING_CHANNELS.app
        ? []
        : await explainIgnoredContacts(supabase, userId, notificationType, ch, marketplaceAccountId || null);

    out.channels[ch] = {
      resolved,
      contacts_ignored: ignored,
    };
  }

  return res.status(200).json(out);
}
