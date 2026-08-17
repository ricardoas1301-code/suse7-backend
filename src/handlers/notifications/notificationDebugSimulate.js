// ============================================================
// POST /api/notifications/debug/simulate — ingest controlado (Fase 3)
// Mesmo gate que GET /api/notifications/debug/resolve (DEV ou Dev Center JWT).
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { resolveDevCenterAccess } from "../devCenter/devCenterAccess.js";
import { ingestNotificationEvent } from "../../domain/notifications/notificationPipeline.js";

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

export async function handleNotificationDebugSimulate(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const nodeEnv = process.env.NODE_ENV ?? "";
  const allowDev = nodeEnv === "development";
  const access = await resolveDevCenterAccess(auth.supabase, auth.user);

  if (!allowDev && !access.allowed) {
    return res.status(403).json({ ok: false, error: "Acesso negado (somente DEV ou Dev Center)." });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "JSON inválido" });
  }

  const notificationType =
    body.notification_type != null ? String(body.notification_type).trim() : "conta_desconectada";
  const marketplaceAccountId =
    body.marketplace_account_id != null && String(body.marketplace_account_id).trim() !== ""
      ? String(body.marketplace_account_id).trim()
      : null;

  const title =
    body.title != null && String(body.title).trim() !== ""
      ? String(body.title).trim()
      : "[Simulação] Evento de teste";
  const message =
    body.message != null && String(body.message).trim() !== ""
      ? String(body.message).trim()
      : "Evento gerado pelo simulador interno do Suse7 (Fase 3).";

  const userId = String(auth.user.id);

  const result = await ingestNotificationEvent(auth.supabase, {
    userId,
    notificationType,
    title,
    message,
    marketplace: body.marketplace != null ? String(body.marketplace) : "mercado_livre",
    marketplaceAccountId,
    entityType: body.entity_type != null ? String(body.entity_type) : "simulation",
    entityId: body.entity_id != null ? String(body.entity_id) : `sim_${Date.now()}`,
    relevanceKey: body.relevance_key != null ? String(body.relevance_key) : `debug_sim_${Date.now()}`,
    skipDedupe: Boolean(body.skip_dedupe),
    eventSeverity:
      body.event_severity != null && typeof body.event_severity === "string"
        ? /** @type {'critical'|'important'|'medium'|'info'} */ (
            body.event_severity.trim().toLowerCase()
          )
        : "important",
    payload: {
      channel_test: Boolean(body.channel_test),
      source: "debug_simulate",
    },
  });

  return res.status(200).json({
    ok: Boolean(result.ok),
    deduped: Boolean(result.skipped),
    event_id: result.event?.id ?? null,
    deliveries_created: result.deliveries_inserted ?? 0,
    fingerprint: result.fingerprint ?? null,
    reason: result.reason ?? result.error ?? null,
    recipients_summary: {
      deliveries_created: result.deliveries_inserted ?? 0,
    },
  });
}
