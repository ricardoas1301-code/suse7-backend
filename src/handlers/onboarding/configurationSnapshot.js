// ======================================================================
// GET /api/onboarding/configuration-snapshot
// READ ONLY — zero side effects
// ======================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { carregarContextoConfiguracaoInicial } from "../../onboarding/services/carregarContextoConfiguracaoInicial.js";
import { resolveConfigurationSnapshot } from "../../onboarding/domain/resolverSnapshotConfiguracaoInicial.js";
import { getTraceId, ok, fail } from "../../infra/http.js";

const LOG_PREFIX = "[S7_ONBOARDING_SNAPSHOT]";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse & { status: Function; json: Function }} res
 */
export async function handleOnboardingConfigurationSnapshot(req, res) {
  const traceId = getTraceId(req);

  if (req.method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
  }

  const { user, supabase } = auth;

  try {
    const ctx = await carregarContextoConfiguracaoInicial(supabase, user.id);

    if (!ctx.ok) {
      console.warn(`${LOG_PREFIX} partial_load`, { user_id: user.id, code: ctx.code, traceId });
      const snapshot = resolveConfigurationSnapshot({
        profile: ctx.profile ?? null,
        companies: ctx.companies ?? [],
        legalAcceptance: ctx.legalAcceptance ?? null,
        marketplaceAccounts: ctx.marketplaceAccounts ?? [],
      });
      return ok(res, { ok: true, ...snapshot, traceId, warning: ctx.code }, 200);
    }

    const snapshot = resolveConfigurationSnapshot({
      profile: ctx.profile,
      companies: ctx.companies,
      legalAcceptance: ctx.legalAcceptance,
      marketplaceAccounts: ctx.marketplaceAccounts ?? [],
    });

    console.info(`${LOG_PREFIX} ok`, {
      user_id: user.id,
      completed: snapshot.configuration.completed,
      percent: snapshot.configuration.percent,
      traceId,
    });

    return ok(res, { ok: true, ...snapshot, traceId }, 200);
  } catch (error) {
    const errorId = Date.now();
    console.error(`${LOG_PREFIX} failed`, { errorId, traceId, message: error?.message ?? error });
    return fail(
      res,
      { code: "SNAPSHOT_UNAVAILABLE", message: "Não foi possível carregar a configuração inicial." },
      500,
      traceId,
    );
  }
}

export default handleOnboardingConfigurationSnapshot;
