// ======================================================
// Dev Center — Estrutura Administrativa Global: rotas de Planos
// ------------------------------------------------------
// Roteia /api/dev-center/admin/plans* para o service de planos.
// Retorna `true` quando trata a rota (padrão handleDevCenterAdminRoutes).
//
// Guard administrativo aplicado em index.js (resolveDevCenterAccess).
//
// Rotas:
//   GET   /api/dev-center/admin/plans
//   PATCH /api/dev-center/admin/plans/:planId
// ======================================================

import { ok, fail } from "../../infra/http.js";
import { listarPlanosAdmin, atualizarPlanoAdmin } from "./devCenterAdminPlansService.js";

const BASE = "/api/dev-center/admin/plans";

/** Operador (preparado para multi-admin). */
function resolverOperadorCtx(ctx) {
  const user = ctx?.user ?? null;
  const name = user?.email != null && String(user.email).trim() ? String(user.email).trim() : "Sistema";
  return { id: user?.id ?? null, name };
}

function statusDoErro(code) {
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_INPUT") return 400;
  return 500;
}

/**
 * @returns {Promise<boolean>} true se a rota foi tratada
 */
export async function handleDevCenterAdminPlansRoutes(req, res, path, method, supabase, traceId, ctx = {}) {
  const body = ctx.body ?? {};
  const operador = resolverOperadorCtx(ctx);

  // GET catálogo de planos
  if (path === BASE && method === "GET") {
    try {
      const result = await listarPlanosAdmin(supabase);
      ok(res, { ok: true, plans: result.plans });
    } catch (error) {
      console.error("[dev-center][admin-plans] list", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao listar planos" }, 500, traceId);
    }
    return true;
  }

  // PATCH plano
  const matchPlan = path.match(/^\/api\/dev-center\/admin\/plans\/([^/]+)$/);
  if (matchPlan && method === "PATCH") {
    const planId = matchPlan[1];
    try {
      const result = await atualizarPlanoAdmin(supabase, planId, body, operador);
      if (!result.ok) {
        fail(res, result.error, statusDoErro(result.error.code), traceId);
      } else {
        ok(res, { ok: true, plan: result.plan });
      }
    } catch (error) {
      console.error("[dev-center][admin-plans] patch", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao atualizar plano" }, 500, traceId);
    }
    return true;
  }

  return false;
}
