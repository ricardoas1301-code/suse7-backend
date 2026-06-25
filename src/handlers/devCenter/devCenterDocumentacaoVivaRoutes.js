// ======================================================
// Dev Center — Documentação Viva: rotas admin
// ------------------------------------------------------
// Roteia /api/dev-center/documentacao-viva/* para o service.
// Retorna `true` quando trata a rota (padrão handleDevCenterAdminRoutes).
//
// Rotas:
//   GET   /api/dev-center/documentacao-viva
//   GET   /api/dev-center/documentacao-viva/history
//   GET   /api/dev-center/documentacao-viva/domains/:domainId/history
//   POST  /api/dev-center/documentacao-viva/domains
//   PATCH /api/dev-center/documentacao-viva/domains/:domainId
//   PATCH /api/dev-center/documentacao-viva/sections/:sectionId
//   PATCH /api/dev-center/documentacao-viva/items/:itemId
// ======================================================

import { ok, fail } from "../../infra/http.js";
import {
  buildDocumentacaoVivaTree,
  criarDominioDocumentacao,
  atualizarDominioDocumentacao,
  atualizarSecaoDocumentacao,
  atualizarItemDocumentacao,
} from "./devCenterDocumentacaoVivaService.js";
import { listarHistoricoDoc } from "./devCenterDocHistoryService.js";

const BASE = "/api/dev-center/documentacao-viva";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Operador (preparado para multi-admin): identifica quem executou a alteração. */
function resolverOperadorCtx(ctx) {
  const user = ctx?.user ?? null;
  const name = user?.email != null && String(user.email).trim() ? String(user.email).trim() : "Sistema";
  return { id: user?.id ?? null, name };
}

/** Mapeia código de erro do service para HTTP status. */
function statusDoErro(code) {
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_INPUT" || code === "SLUG_CONFLICT") return 400;
  return 500;
}

/**
 * @returns {Promise<boolean>} true se a rota foi tratada
 */
export async function handleDocumentacaoVivaRoutes(req, res, path, method, supabase, traceId, ctx = {}) {
  const body = ctx.body ?? {};
  const operador = resolverOperadorCtx(ctx);

  // GET árvore completa
  if (path === BASE && method === "GET") {
    try {
      const tree = await buildDocumentacaoVivaTree(supabase);
      ok(res, { ok: true, domains: tree.domains, degraded: tree.degraded ?? false });
    } catch (error) {
      console.error("[dev-center][doc-viva] tree", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao carregar Documentação Viva" }, 500, traceId);
    }
    return true;
  }

  // GET trilha histórica global (timeline)
  if (path === `${BASE}/history` && method === "GET") {
    try {
      const result = await listarHistoricoDoc(supabase, { limit: 300 });
      ok(res, { ok: true, history: result.history, degraded: result.degraded ?? false });
    } catch (error) {
      console.error("[dev-center][doc-viva] history", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao carregar histórico" }, 500, traceId);
    }
    return true;
  }

  // GET trilha histórica de um domínio
  const matchHistDomain = path.match(
    /^\/api\/dev-center\/documentacao-viva\/domains\/([^/]+)\/history$/,
  );
  if (matchHistDomain && method === "GET") {
    const domainId = matchHistDomain[1];
    if (!UUID_RE.test(domainId)) {
      fail(res, { code: "INVALID_INPUT", message: "domainId inválido" }, 400, traceId);
      return true;
    }
    try {
      const result = await listarHistoricoDoc(supabase, { domainId, limit: 200 });
      ok(res, { ok: true, history: result.history, degraded: result.degraded ?? false });
    } catch (error) {
      console.error("[dev-center][doc-viva] history domain", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao carregar histórico do domínio" }, 500, traceId);
    }
    return true;
  }

  // POST novo domínio
  if (path === `${BASE}/domains` && method === "POST") {
    try {
      const result = await criarDominioDocumentacao(supabase, body, operador);
      if (!result.ok) {
        fail(res, result.error, statusDoErro(result.error.code), traceId);
      } else {
        ok(res, { ok: true, domain: result.domain }, 201);
      }
    } catch (error) {
      console.error("[dev-center][doc-viva] create domain", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao criar domínio" }, 500, traceId);
    }
    return true;
  }

  // PATCH domínio
  const matchDomain = path.match(/^\/api\/dev-center\/documentacao-viva\/domains\/([^/]+)$/);
  if (matchDomain && method === "PATCH") {
    const domainId = matchDomain[1];
    if (!UUID_RE.test(domainId)) {
      fail(res, { code: "INVALID_INPUT", message: "domainId inválido" }, 400, traceId);
      return true;
    }
    try {
      const result = await atualizarDominioDocumentacao(supabase, domainId, body, operador);
      if (!result.ok) {
        fail(res, result.error, statusDoErro(result.error.code), traceId);
      } else {
        ok(res, { ok: true, domain_id: result.domain_id, status: result.status, reaberto: result.reaberto });
      }
    } catch (error) {
      console.error("[dev-center][doc-viva] patch domain", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao atualizar domínio" }, 500, traceId);
    }
    return true;
  }

  // PATCH seção
  const matchSection = path.match(/^\/api\/dev-center\/documentacao-viva\/sections\/([^/]+)$/);
  if (matchSection && method === "PATCH") {
    const sectionId = matchSection[1];
    if (!UUID_RE.test(sectionId)) {
      fail(res, { code: "INVALID_INPUT", message: "sectionId inválido" }, 400, traceId);
      return true;
    }
    try {
      const result = await atualizarSecaoDocumentacao(supabase, sectionId, body, operador);
      if (!result.ok) {
        fail(res, result.error, statusDoErro(result.error.code), traceId);
      } else {
        ok(res, { ok: true, section_id: result.section_id, reaberto: result.reaberto });
      }
    } catch (error) {
      console.error("[dev-center][doc-viva] patch section", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao atualizar seção" }, 500, traceId);
    }
    return true;
  }

  // PATCH item
  const matchItem = path.match(/^\/api\/dev-center\/documentacao-viva\/items\/([^/]+)$/);
  if (matchItem && method === "PATCH") {
    const itemId = matchItem[1];
    if (!UUID_RE.test(itemId)) {
      fail(res, { code: "INVALID_INPUT", message: "itemId inválido" }, 400, traceId);
      return true;
    }
    try {
      const result = await atualizarItemDocumentacao(supabase, itemId, body, operador);
      if (!result.ok) {
        fail(res, result.error, statusDoErro(result.error.code), traceId);
      } else {
        ok(res, { ok: true, item_id: result.item_id, reaberto: result.reaberto });
      }
    } catch (error) {
      console.error("[dev-center][doc-viva] patch item", { message: error?.message, traceId });
      fail(res, { code: "DB_ERROR", message: "Erro ao atualizar item" }, 500, traceId);
    }
    return true;
  }

  return false;
}
