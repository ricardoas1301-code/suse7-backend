// ======================================================
// Dev Center — API interna (missões, handoff, decisões, checklist, histórico)
// Acesso: e-mail allowlist (MVP ricardo@suse7.com.br)
// ======================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { isDevCenterAllowedUser } from "./devCenterAccess.js";
import { insertDevHistory } from "./devCenterHistory.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STATUS_ORDER = [
  "nao_iniciada",
  "iniciada",
  "em_analise",
  "em_execucao",
  "em_validacao",
  "concluida",
  "arquivada",
];

/** @param {string} from @param {string} to */
function canTransitionStatus(from, to) {
  if (from === to) return true;
  const i = STATUS_ORDER.indexOf(from);
  const j = STATUS_ORDER.indexOf(to);
  if (i < 0 || j < 0) return false;
  if (to === "arquivada") return from === "concluida";
  return j === i + 1;
}

/** @param {import("http").IncomingMessage} req */
function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return req.body.trim() ? JSON.parse(req.body) : {};
    } catch {
      return {};
    }
  }
  if (typeof req.body === "object") return /** @type {Record<string, unknown>} */ (req.body);
  return {};
}

/** @param {unknown} v */
function normalizeStatus(v) {
  const s = v != null ? String(v).trim().toLowerCase() : "";
  if (STATUS_ORDER.includes(s)) return s;
  return "nao_iniciada";
}

/** @param {unknown} v */
function normalizePriority(v) {
  const p = v != null ? String(v).trim().toLowerCase() : "";
  const allowed = ["low", "medium", "high", "critical"];
  if (allowed.includes(p)) return p;
  return "medium";
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export async function handleDevCenter(req, res, path) {
  const traceId = getTraceId(req);

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return fail(res, { code: "UNAUTHORIZED", message: "Token não informado" }, 401, traceId);
  }
  const token = authHeader.slice(7);

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);
  if (authError || !user?.id) {
    return fail(res, { code: "UNAUTHORIZED", message: "Token inválido" }, 401, traceId);
  }

  const allowed = isDevCenterAllowedUser(user);
  const userEmail = user.email != null ? String(user.email).trim().toLowerCase() : "";

  if (path === "/api/dev-center/bootstrap" && req.method === "GET") {
    if (!allowed) {
      return ok(res, {
        ok: true,
        allowed: false,
        user_id: user.id,
        email: userEmail || null,
      });
    }
    const { data: missions, error: mErr } = await supabase
      .from("dev_missions")
      .select(
        "id, title, status, priority, module, owner_email, updated_at, created_at"
      )
      .order("updated_at", { ascending: false });
    if (mErr) {
      console.error("[dev-center] bootstrap list", mErr);
      return fail(res, { code: "DB_ERROR", message: "Erro ao listar missões" }, 500, traceId);
    }
    return ok(res, {
      ok: true,
      allowed: true,
      user_id: user.id,
      email: userEmail || null,
      missions: missions ?? [],
    });
  }

  if (!allowed) {
    return fail(
      res,
      { code: "FORBIDDEN", message: "Acesso ao Dev Center restrito a usuários autorizados." },
      403,
      traceId
    );
  }

  const method = req.method || "GET";
  const body = parseBody(req);

  try {
    if (path === "/api/dev-center/missions" && method === "GET") {
      const { data, error } = await supabase
        .from("dev_missions")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) {
        console.error("[dev-center] missions list", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao listar missões" }, 500, traceId);
      }
      return ok(res, { ok: true, missions: data ?? [] });
    }

    if (path === "/api/dev-center/missions" && method === "POST") {
      const title = body.title != null ? String(body.title).trim() : "";
      if (!title) {
        return fail(res, { code: "INVALID_INPUT", message: "title é obrigatório" }, 400, traceId);
      }
      const status = normalizeStatus(body.status ?? "nao_iniciada");
      const priority = normalizePriority(body.priority);
      const ownerEmail =
        body.owner_email != null && String(body.owner_email).trim()
          ? String(body.owner_email).trim().toLowerCase()
          : userEmail || "ricardo@suse7.com.br";
      const row = {
        title,
        status,
        priority,
        module: body.module != null ? String(body.module).trim() || null : null,
        summary: body.summary != null ? String(body.summary) : null,
        owner_email: ownerEmail,
        exec_objective: body.exec_objective != null ? String(body.exec_objective) : null,
        exec_context: body.exec_context != null ? String(body.exec_context) : null,
        exec_problem: body.exec_problem != null ? String(body.exec_problem) : null,
        exec_where_stopped: body.exec_where_stopped != null ? String(body.exec_where_stopped) : null,
        created_by: user.id,
      };
      const { data: mission, error: insErr } = await supabase
        .from("dev_missions")
        .insert(row)
        .select("*")
        .single();
      if (insErr || !mission) {
        console.error("[dev-center] mission insert", insErr);
        return fail(res, { code: "DB_ERROR", message: "Erro ao criar missão" }, 500, traceId);
      }
      const { error: ctxErr } = await supabase.from("dev_conversation_contexts").insert({
        mission_id: mission.id,
        rico_text: "",
        neo_text: "",
        pedro_text: "",
      });
      if (ctxErr) {
        console.error("[dev-center] context insert", ctxErr);
        await supabase.from("dev_missions").delete().eq("id", mission.id);
        return fail(res, { code: "DB_ERROR", message: "Erro ao criar contexto da missão" }, 500, traceId);
      }
      await insertDevHistory(supabase, {
        missionId: mission.id,
        eventType: "mission_created",
        content: { title: mission.title, status: mission.status },
        userId: user.id,
      });
      return ok(res, { ok: true, mission }, 201);
    }

    const missionGet = path.match(/^\/api\/dev-center\/missions\/([^/]+)$/);
    if (missionGet && UUID_RE.test(missionGet[1]) && method === "GET") {
      const missionId = missionGet[1];
      const full = await loadMissionFull(supabase, missionId);
      if (!full) {
        return fail(res, { code: "NOT_FOUND", message: "Missão não encontrada" }, 404, traceId);
      }
      return ok(res, { ok: true, ...full });
    }

    const saveAll = path.match(/^\/api\/dev-center\/missions\/([^/]+)\/save-all$/);
    if (saveAll && UUID_RE.test(saveAll[1]) && method === "POST") {
      const missionId = saveAll[1];
      const m = body.mission && typeof body.mission === "object" ? body.mission : {};
      const ctx = body.context && typeof body.context === "object" ? body.context : {};
      const stepsIn = Array.isArray(body.next_steps) ? body.next_steps : [];

      const { data: existing } = await supabase.from("dev_missions").select("*").eq("id", missionId).maybeSingle();
      if (!existing) {
        return fail(res, { code: "NOT_FOUND", message: "Missão não encontrada" }, 404, traceId);
      }

      let nextStatus = existing.status;
      if (m.status != null) {
        const cand = normalizeStatus(m.status);
        if (!canTransitionStatus(existing.status, cand)) {
          return fail(
            res,
            {
              code: "INVALID_TRANSITION",
              message: `Transição de status inválida: ${existing.status} → ${cand}`,
            },
            400,
            traceId
          );
        }
        nextStatus = cand;
      }

      const patch = {
        title: m.title != null ? String(m.title).trim() : existing.title,
        status: nextStatus,
        priority: m.priority != null ? normalizePriority(m.priority) : existing.priority,
        module: m.module !== undefined ? (m.module != null ? String(m.module).trim() || null : null) : existing.module,
        summary: m.summary !== undefined ? (m.summary != null ? String(m.summary) : null) : existing.summary,
        owner_email:
          m.owner_email !== undefined
            ? m.owner_email != null && String(m.owner_email).trim()
              ? String(m.owner_email).trim().toLowerCase()
              : null
            : existing.owner_email,
        exec_objective:
          m.exec_objective !== undefined
            ? m.exec_objective != null
              ? String(m.exec_objective)
              : null
            : existing.exec_objective,
        exec_context:
          m.exec_context !== undefined
            ? m.exec_context != null
              ? String(m.exec_context)
              : null
            : existing.exec_context,
        exec_problem:
          m.exec_problem !== undefined
            ? m.exec_problem != null
              ? String(m.exec_problem)
              : null
            : existing.exec_problem,
        exec_where_stopped:
          m.exec_where_stopped !== undefined
            ? m.exec_where_stopped != null
              ? String(m.exec_where_stopped)
              : null
            : existing.exec_where_stopped,
      };
      if (!patch.title) {
        return fail(res, { code: "INVALID_INPUT", message: "title não pode ser vazio" }, 400, traceId);
      }

      const { data: missionUp, error: upErr } = await supabase
        .from("dev_missions")
        .update(patch)
        .eq("id", missionId)
        .select("*")
        .single();
      if (upErr || !missionUp) {
        console.error("[dev-center] save-all mission", upErr);
        return fail(res, { code: "DB_ERROR", message: "Erro ao salvar missão" }, 500, traceId);
      }

      if (existing.status !== missionUp.status) {
        await insertDevHistory(supabase, {
          missionId,
          eventType: "status_change",
          content: { from: existing.status, to: missionUp.status },
          userId: user.id,
        });
      }

      const { error: ctxUpErr } = await supabase
        .from("dev_conversation_contexts")
        .update({
          rico_text: ctx.rico_text != null ? String(ctx.rico_text) : "",
          neo_text: ctx.neo_text != null ? String(ctx.neo_text) : "",
          pedro_text: ctx.pedro_text != null ? String(ctx.pedro_text) : "",
        })
        .eq("mission_id", missionId);
      if (ctxUpErr) {
        console.error("[dev-center] save-all context", ctxUpErr);
        return fail(res, { code: "DB_ERROR", message: "Erro ao salvar handoff" }, 500, traceId);
      }

      const { data: existingSteps } = await supabase
        .from("dev_next_steps")
        .select("id")
        .eq("mission_id", missionId);
      const keepIds = new Set(
        stepsIn.map((s) => (s && typeof s === "object" && s.id ? String(s.id) : "")).filter(Boolean)
      );
      for (const row of existingSteps ?? []) {
        if (!keepIds.has(row.id)) {
          await supabase.from("dev_next_steps").delete().eq("id", row.id);
        }
      }
      let ord = 0;
      for (const s of stepsIn) {
        if (!s || typeof s !== "object") continue;
        const text = s.text != null ? String(s.text) : "";
        const is_done = Boolean(s.is_done);
        ord += 1;
        if (s.id && UUID_RE.test(String(s.id))) {
          await supabase
            .from("dev_next_steps")
            .update({ text, is_done, sort_order: ord })
            .eq("id", String(s.id))
            .eq("mission_id", missionId);
        } else if (text.trim()) {
          await supabase.from("dev_next_steps").insert({
            mission_id: missionId,
            text,
            is_done,
            sort_order: ord,
          });
        }
      }

      await insertDevHistory(supabase, {
        missionId,
        eventType: "save_all",
        content: { saved_at: new Date().toISOString() },
        userId: user.id,
      });

      const full = await loadMissionFull(supabase, missionId);
      return ok(res, { ok: true, ...full });
    }

    if (missionGet && UUID_RE.test(missionGet[1]) && method === "PATCH") {
      const missionId = missionGet[1];
      const { data: existing } = await supabase.from("dev_missions").select("*").eq("id", missionId).maybeSingle();
      if (!existing) {
        return fail(res, { code: "NOT_FOUND", message: "Missão não encontrada" }, 404, traceId);
      }

      const patch = {};
      if (body.title != null) patch.title = String(body.title).trim();
      if (patch.title === "") {
        return fail(res, { code: "INVALID_INPUT", message: "title não pode ser vazio" }, 400, traceId);
      }
      if (body.status != null) {
        const cand = normalizeStatus(body.status);
        if (!canTransitionStatus(existing.status, cand)) {
          return fail(
            res,
            {
              code: "INVALID_TRANSITION",
              message: `Transição de status inválida: ${existing.status} → ${cand}`,
            },
            400,
            traceId
          );
        }
        patch.status = cand;
      }
      if (body.priority != null) patch.priority = normalizePriority(body.priority);
      if (body.module !== undefined) patch.module = body.module != null ? String(body.module).trim() || null : null;
      if (body.summary !== undefined) patch.summary = body.summary != null ? String(body.summary) : null;
      if (body.owner_email !== undefined) {
        patch.owner_email =
          body.owner_email != null && String(body.owner_email).trim()
            ? String(body.owner_email).trim().toLowerCase()
            : null;
      }
      if (body.exec_objective !== undefined) {
        patch.exec_objective = body.exec_objective != null ? String(body.exec_objective) : null;
      }
      if (body.exec_context !== undefined) {
        patch.exec_context = body.exec_context != null ? String(body.exec_context) : null;
      }
      if (body.exec_problem !== undefined) {
        patch.exec_problem = body.exec_problem != null ? String(body.exec_problem) : null;
      }
      if (body.exec_where_stopped !== undefined) {
        patch.exec_where_stopped = body.exec_where_stopped != null ? String(body.exec_where_stopped) : null;
      }
      if (Object.keys(patch).length === 0) {
        return fail(res, { code: "INVALID_INPUT", message: "Nenhum campo para atualizar" }, 400, traceId);
      }

      const { data: mission, error } = await supabase
        .from("dev_missions")
        .update(patch)
        .eq("id", missionId)
        .select("*")
        .maybeSingle();
      if (error || !mission) {
        return fail(res, { code: "NOT_FOUND", message: "Missão não encontrada" }, 404, traceId);
      }
      if (patch.status != null && existing.status !== mission.status) {
        await insertDevHistory(supabase, {
          missionId,
          eventType: "status_change",
          content: { from: existing.status, to: mission.status },
          userId: user.id,
        });
      } else {
        await insertDevHistory(supabase, {
          missionId,
          eventType: "mission_update",
          content: { fields: Object.keys(patch) },
          userId: user.id,
        });
      }
      return ok(res, { ok: true, mission });
    }

    const contextPatch = path.match(/^\/api\/dev-center\/missions\/([^/]+)\/context$/);
    if (contextPatch && UUID_RE.test(contextPatch[1]) && method === "PATCH") {
      const missionId = contextPatch[1];
      const ctxPatch = {};
      if (body.rico_text !== undefined) ctxPatch.rico_text = body.rico_text != null ? String(body.rico_text) : "";
      if (body.neo_text !== undefined) ctxPatch.neo_text = body.neo_text != null ? String(body.neo_text) : "";
      if (body.pedro_text !== undefined) ctxPatch.pedro_text = body.pedro_text != null ? String(body.pedro_text) : "";
      if (Object.keys(ctxPatch).length === 0) {
        return fail(res, { code: "INVALID_INPUT", message: "Nenhum campo de contexto" }, 400, traceId);
      }
      const { data: ctx, error } = await supabase
        .from("dev_conversation_contexts")
        .update(ctxPatch)
        .eq("mission_id", missionId)
        .select("*")
        .maybeSingle();
      if (error || !ctx) {
        return fail(res, { code: "NOT_FOUND", message: "Contexto da missão não encontrado" }, 404, traceId);
      }
      await insertDevHistory(supabase, {
        missionId,
        eventType: "handoff_update",
        content: { keys: Object.keys(ctxPatch) },
        userId: user.id,
      });
      return ok(res, { ok: true, context: ctx });
    }

    const nextStepPost = path.match(/^\/api\/dev-center\/missions\/([^/]+)\/next-steps$/);
    if (nextStepPost && UUID_RE.test(nextStepPost[1]) && method === "POST") {
      const missionId = nextStepPost[1];
      const text = body.text != null ? String(body.text).trim() : "";
      if (!text) {
        return fail(res, { code: "INVALID_INPUT", message: "text é obrigatório" }, 400, traceId);
      }
      const { count } = await supabase
        .from("dev_next_steps")
        .select("id", { count: "exact", head: true })
        .eq("mission_id", missionId);
      const sort_order = (count ?? 0) + 1;
      const { data: row, error } = await supabase
        .from("dev_next_steps")
        .insert({ mission_id: missionId, text, is_done: false, sort_order })
        .select("*")
        .single();
      if (error || !row) {
        console.error("[dev-center] next_step insert", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao criar passo" }, 500, traceId);
      }
      await insertDevHistory(supabase, {
        missionId,
        eventType: "next_step_added",
        content: { id: row.id, text: row.text },
        userId: user.id,
      });
      return ok(res, { ok: true, next_step: row }, 201);
    }

    const nextStepId = path.match(/^\/api\/dev-center\/next-steps\/([^/]+)$/);
    if (nextStepId && UUID_RE.test(nextStepId[1]) && method === "PATCH") {
      const id = nextStepId[1];
      const patch = {};
      if (body.text !== undefined) patch.text = body.text != null ? String(body.text) : "";
      if (body.is_done !== undefined) patch.is_done = Boolean(body.is_done);
      if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0;
      if (Object.keys(patch).length === 0) {
        return fail(res, { code: "INVALID_INPUT", message: "Nenhum campo" }, 400, traceId);
      }
      const { data: row, error } = await supabase
        .from("dev_next_steps")
        .update(patch)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error || !row) {
        return fail(res, { code: "NOT_FOUND", message: "Passo não encontrado" }, 404, traceId);
      }
      await insertDevHistory(supabase, {
        missionId: row.mission_id,
        eventType: "next_step_updated",
        content: { id: row.id, patch },
        userId: user.id,
      });
      return ok(res, { ok: true, next_step: row });
    }

    if (nextStepId && UUID_RE.test(nextStepId[1]) && method === "DELETE") {
      const id = nextStepId[1];
      const { data: row } = await supabase.from("dev_next_steps").select("mission_id").eq("id", id).maybeSingle();
      const { error } = await supabase.from("dev_next_steps").delete().eq("id", id);
      if (error) {
        return fail(res, { code: "DB_ERROR", message: "Erro ao excluir passo" }, 500, traceId);
      }
      if (row?.mission_id) {
        await insertDevHistory(supabase, {
          missionId: row.mission_id,
          eventType: "next_step_deleted",
          content: { id },
          userId: user.id,
        });
      }
      return ok(res, { ok: true, deleted: true });
    }

    const decisionsPost = path.match(/^\/api\/dev-center\/missions\/([^/]+)\/decisions$/);
    if (decisionsPost && UUID_RE.test(decisionsPost[1]) && method === "POST") {
      const missionId = decisionsPost[1];
      const decision_text = body.decision_text != null ? String(body.decision_text).trim() : "";
      if (!decision_text) {
        return fail(res, { code: "INVALID_INPUT", message: "decision_text é obrigatório" }, 400, traceId);
      }
      const reason = body.reason != null ? String(body.reason).trim() || null : null;
      const { count: decCount } = await supabase
        .from("dev_decisions")
        .select("id", { count: "exact", head: true })
        .eq("mission_id", missionId);
      const sort_order = typeof body.sort_order === "number" ? body.sort_order : decCount ?? 0;
      const { data: row, error } = await supabase
        .from("dev_decisions")
        .insert({
          mission_id: missionId,
          decision_text,
          reason,
          sort_order,
        })
        .select("*")
        .single();
      if (error || !row) {
        console.error("[dev-center] decision insert", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao criar decisão" }, 500, traceId);
      }
      await insertDevHistory(supabase, {
        missionId,
        eventType: "decision_added",
        content: { id: row.id, decision_text: row.decision_text },
        userId: user.id,
      });
      return ok(res, { ok: true, decision: row }, 201);
    }

    const decisionPatch = path.match(/^\/api\/dev-center\/decisions\/([^/]+)$/);
    if (decisionPatch && UUID_RE.test(decisionPatch[1]) && method === "PATCH") {
      const decisionId = decisionPatch[1];
      const { data: prev } = await supabase.from("dev_decisions").select("mission_id").eq("id", decisionId).maybeSingle();
      const patch = {};
      if (body.decision_text !== undefined) patch.decision_text = String(body.decision_text ?? "");
      if (body.reason !== undefined) patch.reason = body.reason != null ? String(body.reason) : null;
      if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0;
      if (Object.keys(patch).length === 0) {
        return fail(res, { code: "INVALID_INPUT", message: "Nenhum campo para atualizar" }, 400, traceId);
      }
      const { data: row, error } = await supabase
        .from("dev_decisions")
        .update(patch)
        .eq("id", decisionId)
        .select("*")
        .maybeSingle();
      if (error || !row) {
        return fail(res, { code: "NOT_FOUND", message: "Decisão não encontrada" }, 404, traceId);
      }
      if (prev?.mission_id) {
        await insertDevHistory(supabase, {
          missionId: prev.mission_id,
          eventType: "decision_updated",
          content: { id: decisionId },
          userId: user.id,
        });
      }
      return ok(res, { ok: true, decision: row });
    }

    if (decisionPatch && UUID_RE.test(decisionPatch[1]) && method === "DELETE") {
      const decisionId = decisionPatch[1];
      const { data: prev } = await supabase.from("dev_decisions").select("mission_id").eq("id", decisionId).maybeSingle();
      const { error } = await supabase.from("dev_decisions").delete().eq("id", decisionId);
      if (error) {
        console.error("[dev-center] decision delete", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao excluir decisão" }, 500, traceId);
      }
      if (prev?.mission_id) {
        await insertDevHistory(supabase, {
          missionId: prev.mission_id,
          eventType: "decision_deleted",
          content: { id: decisionId },
          userId: user.id,
        });
      }
      return ok(res, { ok: true, deleted: true });
    }

    return fail(res, { code: "NOT_FOUND", message: "Rota Dev Center não encontrada", details: { path, method } }, 404, traceId);
  } catch (e) {
    console.error("[dev-center] error", e);
    return fail(res, { code: "INTERNAL", message: e?.message || "Erro interno" }, 500, traceId);
  }
}

/** @param {import("@supabase/supabase-js").SupabaseClient} supabase */
async function loadMissionFull(supabase, missionId) {
  const { data: mission, error: mErr } = await supabase
    .from("dev_missions")
    .select("*")
    .eq("id", missionId)
    .maybeSingle();
  if (mErr || !mission) return null;

  let { data: ctx } = await supabase
    .from("dev_conversation_contexts")
    .select("*")
    .eq("mission_id", missionId)
    .maybeSingle();

  if (!ctx) {
    const { data: inserted } = await supabase
      .from("dev_conversation_contexts")
      .insert({ mission_id: missionId, rico_text: "", neo_text: "", pedro_text: "" })
      .select("*")
      .single();
    ctx = inserted ?? null;
  }

  const { data: decisions } = await supabase
    .from("dev_decisions")
    .select("*")
    .eq("mission_id", missionId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  const nsRes = await supabase
    .from("dev_next_steps")
    .select("*")
    .eq("mission_id", missionId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  const next_steps = nsRes.error ? [] : nsRes.data ?? [];

  const hiRes = await supabase
    .from("dev_history")
    .select("*")
    .eq("mission_id", missionId)
    .order("created_at", { ascending: false })
    .limit(200);
  const history = hiRes.error ? [] : hiRes.data ?? [];

  return {
    mission,
    context: ctx ?? null,
    decisions: decisions ?? [],
    next_steps,
    history,
  };
}
