// =============================================================================
// APIs seller — Central Notification Engine (Fase 3.1.1 + 3.2.2)
// =============================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { resolveDevCenterAccess } from "../devCenter/devCenterAccess.js";
import { listSellerNotificationCategories } from "../../domain/notifications/central/seller/sellerNotificationCategoriesService.js";
import {
  getSellerNotificationPreferences,
  patchSellerNotificationPreferences,
} from "../../domain/notifications/central/seller/sellerNotificationPreferencesService.js";
import {
  createSellerNotificationRecipient,
  patchSellerNotificationRecipient,
} from "../../domain/notifications/central/seller/sellerNotificationRecipientsService.js";
import {
  listSellerNotificationRecipientGroups,
  createSellerNotificationRecipientGroup,
  patchSellerNotificationRecipientGroup,
  deleteSellerNotificationRecipientGroup,
} from "../../domain/notifications/central/seller/sellerNotificationRecipientGroupsService.js";
import {
  listSellerEventDeliveryRules,
  patchSellerEventDeliveryRules,
} from "../../domain/notifications/central/seller/sellerNotificationEventDeliveryRulesService.js";
import {
  getDailySalesSummaryAutomationRule,
  patchDailySalesSummaryAutomationRule,
} from "../../domain/notifications/central/sales/dailySalesSummaryAutomationRuleService.js";
import { logNotificationUi } from "../../domain/notifications/central/seller/sellerNotificationObservability.js";
import { RECIPIENT_ERROR } from "../../domain/notifications/central/seller/sellerNotificationRecipientValidation.js";

/** @param {string | undefined} errorCode */
function recipientErrorStatus(errorCode) {
  if (errorCode === "NOT_FOUND") return 404;
  if (errorCode === RECIPIENT_ERROR.DUPLICATE_RECIPIENT) return 409;
  return 400;
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return req.body.trim() ? JSON.parse(req.body) : {};
    } catch {
      return null;
    }
  }
  return typeof req.body === "object" ? req.body : {};
}

function jsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: code, message, ...extra });
}

/** @param {Record<string, unknown>} result */
function recipientErrorJson(result) {
  const payload = {
    ok: false,
    error: result.error,
    message: result.message,
  };
  if (result.duplicated_field != null) {
    payload.duplicated_field = result.duplicated_field;
  }
  if (result.field != null) {
    payload.field = result.field;
  }
  return payload;
}

/** @param {Record<string, unknown>} body */
function isPersonRecipientPayload(body) {
  return (
    body.email !== undefined ||
    body.whatsapp !== undefined ||
    (body.channel == null && body.destination == null)
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} id
 */
async function resolveRecipientGroupId(supabase, sellerId, id) {
  const { data: byGroup, error: gErr } = await supabase
    .from("s7_notification_recipients")
    .select("recipient_group_id")
    .eq("seller_id", sellerId)
    .eq("recipient_group_id", id)
    .limit(1);
  if (gErr) throw gErr;
  if (byGroup?.length) return id;

  const { data: row, error: rErr } = await supabase
    .from("s7_notification_recipients")
    .select("recipient_group_id")
    .eq("seller_id", sellerId)
    .eq("id", id)
    .maybeSingle();
  if (rErr) throw rErr;
  return row?.recipient_group_id != null ? String(row.recipient_group_id) : null;
}

/**
 * GET /api/notifications/categories
 */
export async function handleNotificationSellerCategories(req, res) {
  if (req.method !== "GET") {
    return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  try {
    const access = await resolveDevCenterAccess(auth.supabase, auth.user);
    const payload = await listSellerNotificationCategories(auth.supabase, {
      includeDevCenter: access.allowed,
    });
    return res.status(200).json({ ok: true, ...payload });
  } catch (e) {
    logNotificationUi("CATEGORIES_ERR", { message: e?.message });
    return jsonError(res, 500, "INTERNAL", "Erro ao carregar categorias");
  }
}

/**
 * GET | PATCH /api/notifications/preferences
 */
export async function handleNotificationSellerPreferences(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const sellerId = String(auth.user.id);

  if (req.method === "GET") {
    try {
      const data = await getSellerNotificationPreferences(auth.supabase, sellerId);
      return res.status(200).json({ ok: true, ...data });
    } catch (e) {
      logNotificationUi("PREFERENCES_GET_ERR", { message: e?.message });
      return jsonError(res, 500, "INTERNAL", "Erro ao carregar preferências");
    }
  }

  if (req.method === "PATCH") {
    const body = parseBody(req);
    if (body === null) return jsonError(res, 400, "INVALID_JSON", "JSON inválido");
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) {
      return jsonError(res, 400, "EMPTY_UPDATES", "Informe ao menos uma alteração em updates.");
    }

    try {
      const result = await patchSellerNotificationPreferences(auth.supabase, sellerId, updates);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error, message: result.message });
      }
      return res.status(200).json({ ok: true, ...result });
    } catch (e) {
      logNotificationUi("PREFERENCES_PATCH_ERR", { message: e?.message });
      return jsonError(res, 500, "INTERNAL", "Erro ao salvar preferências");
    }
  }

  return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
}

/**
 * GET | PATCH /api/notifications/event-delivery-rules
 */
export async function handleNotificationSellerEventDeliveryRules(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const sellerId = String(auth.user.id);

  if (req.method === "GET") {
    try {
      const data = await listSellerEventDeliveryRules(auth.supabase, sellerId);
      return res.status(200).json({ ok: true, ...data });
    } catch (e) {
      logNotificationUi("EVENT_RULES_GET_ERR", { message: e?.message });
      return jsonError(res, 500, "INTERNAL", "Erro ao carregar regras de entrega");
    }
  }

  if (req.method === "PATCH") {
    const body = parseBody(req);
    if (body === null) return jsonError(res, 400, "INVALID_JSON", "JSON inválido");
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) {
      return jsonError(res, 400, "EMPTY_UPDATES", "Informe ao menos uma regra em updates.");
    }

    try {
      const result = await patchSellerEventDeliveryRules(auth.supabase, sellerId, updates);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error, message: result.message });
      }
      return res.status(200).json({ ok: true, ...result });
    } catch (e) {
      logNotificationUi("EVENT_RULES_PATCH_ERR", { message: e?.message });
      return jsonError(res, 500, "INTERNAL", "Erro ao salvar regras de entrega");
    }
  }

  return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
}

/**
 * GET | POST /api/notifications/recipients
 * PATCH | DELETE /api/notifications/recipients/:id  (id = group_id ou row_id legado)
 */
export async function handleNotificationSellerRecipients(req, res, path) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const sellerId = String(auth.user.id);
  const idMatch = String(path || "").match(/^\/api\/notifications\/recipients\/([^/]+)$/);
  const recipientId = idMatch?.[1] ?? null;

  if (recipientId && req.method === "PATCH") {
    const body = parseBody(req);
    if (body === null) return jsonError(res, 400, "INVALID_JSON", "JSON inválido");
    try {
      if (isPersonRecipientPayload(body)) {
        const groupId = await resolveRecipientGroupId(auth.supabase, sellerId, recipientId);
        if (!groupId) {
          return jsonError(res, 404, "NOT_FOUND", "Destinatário não encontrado.");
        }
        const result = await patchSellerNotificationRecipientGroup(
          auth.supabase,
          sellerId,
          groupId,
          body
        );
        if (!result.ok) {
          return res.status(recipientErrorStatus(result.error)).json(recipientErrorJson(result));
        }
        return res.status(200).json({ ok: true, group: result.group });
      }

      const result = await patchSellerNotificationRecipient(
        auth.supabase,
        sellerId,
        recipientId,
        body
      );
      if (!result.ok) {
        return res.status(recipientErrorStatus(result.error)).json(recipientErrorJson(result));
      }
      return res.status(200).json({ ok: true, recipient: result.recipient });
    } catch (e) {
      return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao atualizar destinatário");
    }
  }

  if (recipientId && req.method === "DELETE") {
    try {
      const groupId = await resolveRecipientGroupId(auth.supabase, sellerId, recipientId);
      if (!groupId) {
        return jsonError(res, 404, "NOT_FOUND", "Destinatário não encontrado.");
      }
      const result = await deleteSellerNotificationRecipientGroup(auth.supabase, sellerId, groupId);
      if (!result.ok) {
        const status = result.error === "NOT_FOUND" ? 404 : 400;
        return res.status(status).json({ ok: false, error: result.error, message: result.message });
      }
      return res.status(200).json({ ok: true, deleted_group_id: result.deleted_group_id });
    } catch (e) {
      return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao remover destinatário");
    }
  }

  if (!recipientId && req.method === "GET") {
    try {
      const data = await listSellerNotificationRecipientGroups(auth.supabase, sellerId);
      return res.status(200).json({ ok: true, ...data });
    } catch (e) {
      return jsonError(res, 500, "INTERNAL", "Erro ao listar destinatários");
    }
  }

  if (!recipientId && req.method === "POST") {
    const body = parseBody(req);
    if (body === null) return jsonError(res, 400, "INVALID_JSON", "JSON inválido");
    try {
      if (isPersonRecipientPayload(body)) {
        const result = await createSellerNotificationRecipientGroup(auth.supabase, sellerId, body);
        if (!result.ok) {
          return res.status(recipientErrorStatus(result.error)).json(recipientErrorJson(result));
        }
        return res.status(201).json({ ok: true, group: result.group });
      }

      const result = await createSellerNotificationRecipient(auth.supabase, sellerId, body);
      if (!result.ok) {
        return res.status(recipientErrorStatus(result.error)).json(recipientErrorJson(result));
      }
      return res.status(201).json({ ok: true, recipient: result.recipient });
    } catch (e) {
      return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao criar destinatário");
    }
  }

  return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
}

/**
 * GET | PATCH /api/notifications/automation-rules/daily-sales-summary
 */
export async function handleNotificationSellerDailySalesSummaryAutomation(req, res) {
  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const sellerId = String(auth.user.id);

  if (req.method === "GET") {
    try {
      const rule = await getDailySalesSummaryAutomationRule(auth.supabase, sellerId);
      return res.status(200).json({ ok: true, rule });
    } catch (e) {
      logNotificationUi("DAILY_SALES_SUMMARY_RULE_GET_ERR", { message: e?.message });
      return jsonError(res, 500, "INTERNAL", "Erro ao carregar regra de automação.");
    }
  }

  if (req.method === "PATCH") {
    const body = parseBody(req);
    if (body === null) return jsonError(res, 400, "INVALID_JSON", "JSON inválido");
    try {
      const result = await patchDailySalesSummaryAutomationRule(auth.supabase, sellerId, body);
      if (!result.ok) {
        return res.status(400).json({ ok: false, error: result.error, message: result.message });
      }
      return res.status(200).json({ ok: true, rule: result.rule });
    } catch (e) {
      logNotificationUi("DAILY_SALES_SUMMARY_RULE_PATCH_ERR", { message: e?.message });
      return jsonError(res, 500, "INTERNAL", "Erro ao salvar regra de automação.");
    }
  }

  return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
}
