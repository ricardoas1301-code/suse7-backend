// ======================================================
// Dev Center — Rotas: Features Globais (S1_4) + Auditoria (S1_5)
// ------------------------------------------------------
// Guard administrativo aplicado em index.js (resolveDevCenterAccess).
//
// Rotas:
//   GET   /api/dev-center/admin/features
//   POST  /api/dev-center/admin/features
//   PATCH /api/dev-center/admin/features/:featureId
//   PATCH /api/dev-center/admin/features/:featureId/assignments
//   GET   /api/dev-center/admin/audit
// ======================================================

import { ok, fail } from "../../infra/http.js";
import {
  listarFeaturesAdmin,
  criarFeatureAdmin,
  atualizarFeatureAdmin,
  definirVinculoFeatureAdmin,
} from "./devCenterAdminFeaturesService.js";
import { listarAuditoriaAdmin } from "./devCenterAdminAuditService.js";

const FEATURES_BASE = "/api/dev-center/admin/features";
const AUDIT_BASE = "/api/dev-center/admin/audit";

/** Operador (preparado para multi-admin — S1_5.2). */
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
export async function handleDevCenterAdminFeaturesRoutes(req, res, path, method, supabase, traceId, ctx = {}) {
  const body = ctx.body ?? {};
  const operador = resolverOperadorCtx(ctx);

  // GET catálogo + vínculos
  if (path === FEATURES_BASE && method === "GET") {
    try {
      const result = await listarFeaturesAdmin(supabase);
      ok(res, { ok: true, features: result.features, assignments: result.assignments, degraded: result.degraded ?? false });
    } catch (error) {
      console.error("[dev-center][admin-features] list", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao listar features" }, 500, traceId);
    }
    return true;
  }

  // POST criar feature
  if (path === FEATURES_BASE && method === "POST") {
    try {
      const result = await criarFeatureAdmin(supabase, body, operador);
      if (!result.ok) fail(res, result.error, statusDoErro(result.error.code), traceId);
      else ok(res, { ok: true, feature: result.feature }, 201);
    } catch (error) {
      console.error("[dev-center][admin-features] create", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao criar feature" }, 500, traceId);
    }
    return true;
  }

  // PATCH vínculo feature × escopo
  const matchAssign = path.match(/^\/api\/dev-center\/admin\/features\/([^/]+)\/assignments$/);
  if (matchAssign && method === "PATCH") {
    try {
      const result = await definirVinculoFeatureAdmin(supabase, matchAssign[1], body, operador);
      if (!result.ok) fail(res, result.error, statusDoErro(result.error.code), traceId);
      else ok(res, { ok: true, assignment: result.assignment });
    } catch (error) {
      console.error("[dev-center][admin-features] assignment", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao vincular feature" }, 500, traceId);
    }
    return true;
  }

  // PATCH feature
  const matchFeature = path.match(/^\/api\/dev-center\/admin\/features\/([^/]+)$/);
  if (matchFeature && method === "PATCH") {
    try {
      const result = await atualizarFeatureAdmin(supabase, matchFeature[1], body, operador);
      if (!result.ok) fail(res, result.error, statusDoErro(result.error.code), traceId);
      else ok(res, { ok: true, feature: result.feature });
    } catch (error) {
      console.error("[dev-center][admin-features] patch", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao atualizar feature" }, 500, traceId);
    }
    return true;
  }

  // GET auditoria administrativa (timeline)
  if (path === AUDIT_BASE && method === "GET") {
    try {
      const url = new URL(req.url || "", `http://${req.headers?.host || "localhost"}`);
      const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      const entity = url.searchParams.get("entity");
      const onlyCritical = url.searchParams.get("critical") === "true";
      const result = await listarAuditoriaAdmin(supabase, {
        limit: Number.isFinite(limit) ? limit : 100,
        entity: entity || null,
        onlyCritical,
      });
      ok(res, { ok: true, entries: result.entries, degraded: result.degraded ?? false });
    } catch (error) {
      console.error("[dev-center][admin-features] audit", { message: error?.message, traceId });
      ok(res, { ok: true, entries: [], degraded: true });
    }
    return true;
  }

  return false;
}
