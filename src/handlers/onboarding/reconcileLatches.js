// ======================================================================
// POST /api/onboarding/reconcile-latches — recovery idempotente (Bearer only)
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { reconciliarLatchesConfiguracaoInicial } from "../../onboarding/services/registrarLatchesPosPrimeiraIntegracao.js";
import { getTraceId, ok, fail } from "../../infra/http.js";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export async function handleOnboardingReconcileLatches(req, res) {
  const traceId = getTraceId(req);

  if (req.method !== "POST") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
  }

  try {
    const result = await reconciliarLatchesConfiguracaoInicial(auth.supabase, auth.user.id);
    if (!result.ok) {
      return fail(
        res,
        { code: result.code ?? "RECONCILE_SKIPPED", message: result.message ?? "Reconciliação não aplicável." },
        409,
        traceId,
      );
    }
    return ok(res, { ok: true, ...result, traceId }, 200);
  } catch (error) {
    console.error("[S7_ONBOARDING_RECONCILE] failed", {
      traceId,
      message: error?.message ?? error,
    });
    return fail(
      res,
      { code: "RECONCILE_ERROR", message: "Não foi possível reconciliar os marcos de configuração." },
      500,
      traceId,
    );
  }
}

export default handleOnboardingReconcileLatches;
