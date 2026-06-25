// ============================================================
// CRUD — /api/notifications/contacts (+ /:id)
// Destinatários operacionais (sem usuário de sistema)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  isUuid,
  sanitizeWhatsApp,
  sanitizeEmail,
  validateContactChannels,
} from "../../domain/notificationContactSanitize.js";

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

function extractContactIdFromPath(path) {
  return String(path || "").match(/^\/api\/notifications\/contacts\/([^/]+)$/)?.[1] ?? null;
}

export async function handleNotificationContacts(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(503).json({ ok: false, error: auth.error.message });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("notification_contacts")
      .select("id, user_id, name, role, whatsapp, email, active, created_at, updated_at")
      .eq("user_id", user.id)
      .order("active", { ascending: false })
      .order("name", { ascending: true });

    if (error) {
      console.error("[notificationContacts] GET list", error);
      return res.status(500).json({ ok: false, error: "Erro ao listar destinatários" });
    }
    return res.status(200).json({ ok: true, contacts: data ?? [] });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = parseBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: "JSON inválido" });
    }

    const name = body?.name != null ? String(body.name).trim() : "";
    if (!name || name.length > 200) {
      return res.status(400).json({ ok: false, error: "Nome é obrigatório (máx. 200 caracteres)." });
    }

    const role = body?.role != null && String(body.role).trim() !== "" ? String(body.role).trim().slice(0, 200) : null;
    const whatsapp = sanitizeWhatsApp(body?.whatsapp);
    const email = sanitizeEmail(body?.email);
    const channelCheck = validateContactChannels({ whatsapp, email });
    if (!channelCheck.ok) {
      return res.status(400).json({ ok: false, error: channelCheck.message });
    }

    let active = true;
    if (typeof body?.active === "boolean") active = body.active;

    const { data, error } = await supabase
      .from("notification_contacts")
      .insert({
        user_id: user.id,
        name,
        role,
        whatsapp,
        email,
        active,
      })
      .select("id, user_id, name, role, whatsapp, email, active, created_at, updated_at")
      .single();

    if (error) {
      console.error("[notificationContacts] POST insert", error);
      return res.status(500).json({ ok: false, error: "Erro ao criar destinatário" });
    }

    return res.status(201).json({ ok: true, contact: data });
  }

  return res.status(405).json({ ok: false, error: "Método não permitido" });
}

export async function handleNotificationContactById(req, res, path) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(503).json({ ok: false, error: auth.error.message });
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const id = extractContactIdFromPath(path);
  if (!id || !isUuid(id)) {
    return res.status(400).json({ ok: false, error: "ID inválido" });
  }

  const { data: existing, error: loadErr } = await supabase
    .from("notification_contacts")
    .select("id, user_id, name, role, whatsapp, email, active")
    .eq("id", id)
    .maybeSingle();

  if (loadErr) {
    console.error("[notificationContacts] load one", loadErr);
    return res.status(500).json({ ok: false, error: "Erro ao carregar destinatário" });
  }
  if (!existing || existing.user_id !== user.id) {
    return res.status(404).json({ ok: false, error: "Destinatário não encontrado" });
  }

  if (req.method === "PATCH") {
    let body;
    try {
      body = parseBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: "JSON inválido" });
    }

    const patch = {};
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name || name.length > 200) {
        return res.status(400).json({ ok: false, error: "Nome inválido" });
      }
      patch.name = name;
    }
    if (body.role !== undefined) {
      patch.role =
        body.role != null && String(body.role).trim() !== "" ? String(body.role).trim().slice(0, 200) : null;
    }
    if (body.whatsapp !== undefined) {
      patch.whatsapp = sanitizeWhatsApp(body.whatsapp);
    }
    if (body.email !== undefined) {
      patch.email = sanitizeEmail(body.email);
    }
    if (typeof body.active === "boolean") {
      patch.active = body.active;
    }

    const merged = {
      ...existing,
      ...patch,
    };
    const channelCheck = validateContactChannels({
      whatsapp: merged.whatsapp,
      email: merged.email,
    });
    if (!channelCheck.ok) {
      return res.status(400).json({ ok: false, error: channelCheck.message });
    }

    const { data, error } = await supabase
      .from("notification_contacts")
      .update(patch)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id, user_id, name, role, whatsapp, email, active, created_at, updated_at")
      .single();

    if (error) {
      console.error("[notificationContacts] PATCH", error);
      return res.status(500).json({ ok: false, error: "Erro ao atualizar destinatário" });
    }

    return res.status(200).json({ ok: true, contact: data });
  }

  if (req.method === "DELETE") {
    const { data, error } = await supabase
      .from("notification_contacts")
      .update({ active: false })
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id, user_id, name, role, whatsapp, email, active, created_at, updated_at")
      .single();

    if (error) {
      console.error("[notificationContacts] soft DELETE", error);
      return res.status(500).json({ ok: false, error: "Erro ao desativar destinatário" });
    }

    return res.status(200).json({ ok: true, contact: data, message: "Destinatário desativado" });
  }

  return res.status(405).json({ ok: false, error: "Método não permitido" });
}
