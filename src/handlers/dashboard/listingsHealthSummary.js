// ======================================================================
// GET /api/dashboard/listings-health-summary
// Central de Saúde dos Anúncios — Dashboard executivo.
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { gatePremiumHandler } from "../../billing/middleware/requirePlanAccess.js";
import {
  buildListingsHealthSummary,
  buildEmptyListingsHealthSummaryPayload,
} from "../../domain/dashboard/buildListingsHealthSummary.js";

const LOG_PREFIX = "[S7_LISTINGS_HEALTH_SUMMARY]";

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

export async function handleDashboardListingsHealthSummary(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  logHandler("started", { method: req.method });

  const auth = await requireAuthUser(req);
  if (auth.error) {
    if (auth.error.code === "CONFIG_ERROR") {
      return res.status(200).json(buildEmptyListingsHealthSummaryPayload());
    }
    return res.status(auth.error.status).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  if (await gatePremiumHandler(res, supabase, user.id, { module: "anuncios" })) return;

  const marketplaceAccountId =
    req.query?.marketplace_account_id != null && String(req.query.marketplace_account_id).trim() !== ""
      ? String(req.query.marketplace_account_id).trim()
      : req.query?.account_id != null && String(req.query.account_id).trim() !== ""
        ? String(req.query.account_id).trim()
        : null;
  const marketplace =
    req.query?.marketplace != null && String(req.query.marketplace).trim() !== ""
      ? String(req.query.marketplace).trim()
      : null;
  const commercialPreset =
    req.query?.period_preset != null && String(req.query.period_preset).trim() !== ""
      ? String(req.query.period_preset).trim()
      : null;
  const dateFrom =
    req.query?.date_from != null && String(req.query.date_from).trim() !== ""
      ? String(req.query.date_from).trim()
      : req.query?.start_date != null && String(req.query.start_date).trim() !== ""
        ? String(req.query.start_date).trim()
        : null;
  const dateTo =
    req.query?.date_to != null && String(req.query.date_to).trim() !== ""
      ? String(req.query.date_to).trim()
      : req.query?.end_date != null && String(req.query.end_date).trim() !== ""
        ? String(req.query.end_date).trim()
        : null;

  logHandler("params", {
    user_id: user.id,
    marketplace_account_id: marketplaceAccountId,
    marketplace,
    period_preset: commercialPreset,
    date_from: dateFrom,
    date_to: dateTo,
  });

  try {
    const payload = await buildListingsHealthSummary(supabase, user.id, {
      marketplaceAccountId,
      marketplace,
      commercialPreset,
      dateFrom,
      dateTo,
    });
    return res.status(200).json(payload);
  } catch (error) {
    logHandlerFailed("handler_build", error);
    return res.status(200).json({
      ...buildEmptyListingsHealthSummaryPayload({
        marketplace_account_id: marketplaceAccountId,
        marketplace,
        date_from: dateFrom,
        date_to: dateTo,
      }),
      ok: false,
      error: error instanceof Error ? error.message : "Não foi possível carregar a Central de Saúde dos Anúncios.",
    });
  }
}

export default handleDashboardListingsHealthSummary;
