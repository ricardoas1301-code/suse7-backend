// ======================================================================
// PATCH /api/onboarding/operational-cycle — confirmação M5 (write canônico)
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { persistirCicloOperacionalConta } from "../../onboarding/services/persistirCicloOperacionalConta.js";
import { getTraceId, ok, fail } from "../../infra/http.js";

const LOG_PREFIX = "[S7_ONBOARDING_OPERATIONAL_CYCLE]";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse & { status: Function; json: Function }} res
 */
export async function handleOnboardingOperationalCycleSave(req, res) {
  const traceId = getTraceId(req);

  if (req.method !== "PATCH" && req.method !== "POST") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use PATCH" }, 405, traceId);
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
  }

  const { user, supabase } = auth;
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    const result = await persistirCicloOperacionalConta(supabase, user.id, body);
    if (!result.ok) {
      const status = result.code === "PERSISTENCE_ERROR" ? 500 : 400;
      return fail(
        res,
        { code: result.code, message: result.message ?? "Dados inválidos." },
        status,
        traceId,
      );
    }

    console.info(`${LOG_PREFIX} ok`, {
      user_id: user.id,
      first_confirmation: result.first_confirmation,
      traceId,
    });

    return ok(
      res,
      {
        ok: true,
        operational_day_closes_at: result.profile?.operational_day_closes_at,
        operational_working_days: result.profile?.operational_working_days,
        operational_cycle_configured_at: result.configured_at,
        traceId,
      },
      200,
    );
  } catch (error) {
    const errorId = Date.now();
    console.error(`${LOG_PREFIX} failed`, { errorId, traceId, message: error?.message ?? error });
    return fail(
      res,
      { code: "SAVE_UNAVAILABLE", message: "Não foi possível salvar a configuração operacional." },
      500,
      traceId,
    );
  }
}

export default handleOnboardingOperationalCycleSave;
