// ======================================================================
// GET /api/dashboard/pricing-health-summary
// Central de Saúde da Precificação — Dashboard executivo.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import {
  buildPricingHealthSummary,
  buildEmptyPricingHealthSummaryPayload,
} from "../../domain/dashboard/buildPricingHealthSummary.js";

const LOG_PREFIX = "[S7_PRICING_HEALTH_SUMMARY]";

/** @param {string} label @param {Record<string, unknown>} [payload] */
function logHandler(label, payload = {}) {
  console.info(`${LOG_PREFIX} ${label}`, payload);
}

/** @param {string} stage @param {unknown} error */
function logHandlerFailed(stage, error) {
  const err = error instanceof Error ? error : new Error(String(error ?? "unknown"));
  console.error(`${LOG_PREFIX} failed`, {
    stage,
    message: err.message,
    stack: err.stack,
  });
}

export async function handleDashboardPricingHealthSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  logHandler("started", { method: req.method });

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json(buildEmptyPricingHealthSummaryPayload());
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "anuncios" })) return;

  const periodPreset =
    req.query?.period_preset != null && String(req.query.period_preset).trim() !== ""
      ? String(req.query.period_preset).trim()
      : null;
  const dateFrom =
    req.query?.date_from != null && String(req.query.date_from).trim() !== ""
      ? String(req.query.date_from).trim()
      : null;
  const dateTo =
    req.query?.date_to != null && String(req.query.date_to).trim() !== ""
      ? String(req.query.date_to).trim()
      : null;

  logHandler("params", {
    user_id: user.id,
    note: "Central de Saúde da Precificação usa estado atual — period_preset ignorado",
    period_preset_ignored: periodPreset,
    date_from_ignored: dateFrom,
    date_to_ignored: dateTo,
  });

  try {
    const payload = await buildPricingHealthSummary(supabase, user.id, {
      periodPreset,
      dateFrom,
      dateTo,
    });
    return res.status(200).json(payload);
  } catch (error) {
    logHandlerFailed("handler_build", error);
    return res.status(200).json({
      ...buildEmptyPricingHealthSummaryPayload({
        period_preset: periodPreset,
        date_from: dateFrom,
        date_to: dateTo,
      }),
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível carregar a Central de Saúde da Precificação.",
    });
  }
}

export default handleDashboardPricingHealthSummary;
