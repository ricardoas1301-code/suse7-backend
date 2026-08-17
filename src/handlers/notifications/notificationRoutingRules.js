// ============================================================
// GET/PUT — /api/notifications/routing-rules
// Substituição em lote por (user, notification_type, notification_channel)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  isValidRoutingChannel,
  isValidRoutingNotificationType,
  NOTIFICATION_ROUTING_CHANNELS,
  NOTIFICATION_ROUTING_TYPE_LOOKUP,
} from "../../domain/notificationRoutingCatalog.js";
import { isUuid } from "../../domain/notificationContactSanitize.js";

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

async function assertAccountsOwned(supabase, userId, accountIds) {
  const uniq = [...new Set(accountIds.map((x) => String(x).trim()).filter(Boolean))];
  if (uniq.length === 0) return { ok: true, owned: new Set() };

  const { data, error } = await supabase.from("marketplace_accounts").select("id").eq("user_id", userId).in("id", uniq);

  if (error) {
    console.error("[routingRules] marketplace_accounts assert", error);
    return { ok: false, error: "Erro ao validar contas marketplace" };
  }

  const owned = new Set((data ?? []).map((r) => String(r.id)));
  for (const id of uniq) {
    if (!owned.has(id)) {
      return { ok: false, error: "Conta marketplace inválida ou de outro usuário" };
    }
  }
  return { ok: true, owned };
}

async function assertContactsOwned(supabase, userId, contactIds) {
  const uniq = [...new Set(contactIds.map((x) => String(x).trim()).filter(Boolean))];
  if (uniq.length === 0) return { ok: true };

  const { data, error } = await supabase.from("notification_contacts").select("id").eq("user_id", userId).in("id", uniq);

  if (error) {
    console.error("[routingRules] notification_contacts assert", error);
    return { ok: false, error: "Erro ao validar destinatários" };
  }

  const owned = new Set((data ?? []).map((r) => String(r.id)));
  for (const id of uniq) {
    if (!owned.has(id)) {
      return { ok: false, error: "Destinatário inválido ou de outro usuário" };
    }
  }
  return { ok: true };
}

function expandRows(userId, notificationType, notificationChannel, rulesInput) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];

  for (const rule of rulesInput) {
    const rawContact = rule?.contact_id;
    const contactId =
      rawContact != null && String(rawContact).trim() !== "" && isUuid(String(rawContact))
        ? String(rawContact).trim()
        : null;

    const accountIdsRaw = Array.isArray(rule?.marketplace_account_ids) ? rule.marketplace_account_ids : [];
    const accountIds = [...new Set(accountIdsRaw.map((x) => String(x).trim()).filter((x) => isUuid(x)))];

    if (notificationChannel === NOTIFICATION_ROUTING_CHANNELS.app) {
      if (accountIds.length === 0) {
        rows.push({
          user_id: userId,
          notification_type: notificationType,
          notification_channel: notificationChannel,
          contact_id: null,
          marketplace_account_id: null,
          active: true,
        });
      } else {
        for (const aid of accountIds) {
          rows.push({
            user_id: userId,
            notification_type: notificationType,
            notification_channel: notificationChannel,
            contact_id: null,
            marketplace_account_id: aid,
            active: true,
          });
        }
      }
      continue;
    }

    if (!contactId) {
      throw new Error("CONTACT_REQUIRED");
    }

    const catalog = NOTIFICATION_ROUTING_TYPE_LOOKUP[notificationType];
    if (catalog && catalog.supportsAccountRouting === false) {
      rows.push({
        user_id: userId,
        notification_type: notificationType,
        notification_channel: notificationChannel,
        contact_id: contactId,
        marketplace_account_id: null,
        active: true,
      });
      continue;
    }

    if (accountIds.length === 0) {
      throw new Error("ACCOUNTS_REQUIRED");
    }

    for (const aid of accountIds) {
      rows.push({
        user_id: userId,
        notification_type: notificationType,
        notification_channel: notificationChannel,
        contact_id: contactId,
        marketplace_account_id: aid,
        active: true,
      });
    }
  }

  return rows;
}

export async function handleNotificationRoutingRules(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(503).json({ ok: false, error: auth.error.message });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  if (req.method === "GET") {
    const typeFilter = req.query?.notification_type != null ? String(req.query.notification_type).trim() : "";
    const channelFilter = req.query?.notification_channel != null ? String(req.query.notification_channel).trim() : "";
    const accountFilter =
      req.query?.marketplace_account_id != null ? String(req.query.marketplace_account_id).trim() : "";
    const includeInactive =
      req.query?.include_inactive === "true" || req.query?.include_inactive === "1";

    let q = supabase
      .from("notification_routing_rules")
      .select("id, user_id, notification_type, notification_channel, contact_id, marketplace_account_id, active, created_at, updated_at")
      .eq("user_id", user.id);

    if (!includeInactive) {
      q = q.eq("active", true);
    }
    if (typeFilter) {
      q = q.eq("notification_type", typeFilter);
    }
    if (channelFilter) {
      q = q.eq("notification_channel", channelFilter);
    }
    if (accountFilter && isUuid(accountFilter)) {
      q = q.eq("marketplace_account_id", accountFilter);
    }

    const { data, error } = await q
      .order("notification_type", { ascending: true })
      .order("notification_channel", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[routingRules] GET", error);
      return res.status(500).json({ ok: false, error: "Erro ao listar regras" });
    }

    return res.status(200).json({ ok: true, rules: data ?? [] });
  }

  if (req.method === "PUT") {
    let body;
    try {
      body = parseBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: "JSON inválido" });
    }

    const notificationType =
      body?.notification_type != null ? String(body.notification_type).trim() : "";
    const notificationChannel =
      body?.notification_channel != null ? String(body.notification_channel).trim() : "";

    if (!isValidRoutingNotificationType(notificationType)) {
      return res.status(400).json({ ok: false, error: "notification_type inválido" });
    }
    if (!isValidRoutingChannel(notificationChannel)) {
      return res.status(400).json({ ok: false, error: "notification_channel inválido" });
    }

    const rulesInput = Array.isArray(body?.rules) ? body.rules : [];

    /** @type {ReturnType<typeof expandRows>} */
    let rows;
    try {
      rows = expandRows(user.id, notificationType, notificationChannel, rulesInput);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "CONTACT_REQUIRED") {
        return res.status(400).json({
          ok: false,
          error: "Para e-mail ou WhatsApp, cada regra precisa de um destinatário (contact_id).",
        });
      }
      if (code === "ACCOUNTS_REQUIRED") {
        return res.status(400).json({
          ok: false,
          error: "Selecione ao menos uma conta marketplace para cada destinatário.",
        });
      }
      return res.status(400).json({ ok: false, error: "Payload de regras inválido" });
    }

    const contactIdsNeeded = rows.map((r) => r.contact_id).filter((id) => id != null);
    const accountIdsNeeded = rows.map((r) => r.marketplace_account_id).filter((id) => id != null);

    const cOwn = await assertContactsOwned(supabase, user.id, /** @type {string[]} */ (contactIdsNeeded));
    if (!cOwn.ok) {
      return res.status(400).json({ ok: false, error: cOwn.error });
    }

    const aOwn = await assertAccountsOwned(supabase, user.id, /** @type {string[]} */ (accountIdsNeeded));
    if (!aOwn.ok) {
      return res.status(400).json({ ok: false, error: aOwn.error });
    }

    const { error: deactivateErr } = await supabase
      .from("notification_routing_rules")
      .update({ active: false })
      .eq("user_id", user.id)
      .eq("notification_type", notificationType)
      .eq("notification_channel", notificationChannel);

    if (deactivateErr) {
      console.error("[routingRules] deactivate old", deactivateErr);
      return res.status(500).json({ ok: false, error: "Erro ao atualizar regras antigas" });
    }

    if (rows.length === 0) {
      return res.status(200).json({ ok: true, rules: [], message: "Nenhuma regra ativa para este canal/tipo." });
    }

    const deduped = [];
    const seen = new Set();
    for (const r of rows) {
      const k = `${r.contact_id ?? ""}|${r.marketplace_account_id ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }

    const { data: inserted, error: insErr } = await supabase
      .from("notification_routing_rules")
      .insert(deduped)
      .select("id, user_id, notification_type, notification_channel, contact_id, marketplace_account_id, active, created_at, updated_at");

    if (insErr) {
      console.error("[routingRules] insert", insErr);
      return res.status(500).json({ ok: false, error: "Erro ao gravar novas regras" });
    }

    return res.status(200).json({ ok: true, rules: inserted ?? [] });
  }

  return res.status(405).json({ ok: false, error: "Método não permitido" });
}
