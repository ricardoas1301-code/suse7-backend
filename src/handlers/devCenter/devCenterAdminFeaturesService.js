// ======================================================
// Dev Center — Gestão Administrativa de Features Globais (backend)
// ------------------------------------------------------
// Catálogo global de features + vínculo feature × escopo.
//   • Catálogo persistido (não-hardcoded na UI).
//   • Feature flag global via status (ativa/inativa).
//   • rollout_stage prepara rollout futuro (sem implementá-lo).
//   • Vínculo preparado para Global/Plano/Seller/Conta (usamos plan agora).
//
// Toda mutação passa pela auditoria administrativa global (best-effort),
// classificando operações críticas (S1_5.4). Supabase só via backend.
// ======================================================

import { registrarAuditoriaAdmin, registrarAuditoriaAdminLote } from "./devCenterAdminAuditService.js";

const TABELA_FEATURES = "devcenter_features";
const TABELA_ASSIGN = "devcenter_feature_assignments";
const ORIGIN = "dev_center_admin_features";

const STATUS_VALIDOS = ["ativa", "inativa"];
const ROLLOUT_VALIDOS = ["ga", "beta", "interno", "experimental"];
const SCOPES_VALIDOS = ["global", "plan", "seller", "marketplace_account"];
const FEATURE_KEY_RE = /^[a-z0-9_]{3,60}$/;

const FEATURE_SELECT =
  "id, feature_key, label, description, category, status, rollout_stage, sort_order, created_at, updated_at";
const ASSIGN_SELECT = "id, feature_id, scope, scope_id, enabled, metadata, created_at, updated_at";

function isMissingSchemaError(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return code === "42P01" || code === "42703" || msg.includes("does not exist") || msg.includes("schema cache");
}

/** @param {Record<string, unknown>} row */
function mapFeature(row) {
  const status = String(row.status ?? "ativa");
  return {
    id: String(row.id),
    feature_key: row.feature_key ?? "",
    label: row.label ?? "",
    description: row.description ?? "",
    category: row.category ?? "geral",
    status,
    is_global_enabled: status === "ativa",
    rollout_stage: row.rollout_stage ?? "ga",
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** @param {Record<string, unknown>} row */
function mapAssignment(row) {
  return {
    id: String(row.id),
    feature_id: String(row.feature_id),
    scope: row.scope ?? "plan",
    scope_id: row.scope_id ?? null,
    enabled: row.enabled !== false,
  };
}

/** Slug seguro para feature_key. */
function gerarFeatureKey(raw, label) {
  const base = String(raw || label || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return base;
}

/**
 * Lista o catálogo + vínculos (scope=plan) para a matriz Plano × Feature.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function listarFeaturesAdmin(supabase) {
  const { data: featRows, error: featErr } = await supabase
    .from(TABELA_FEATURES)
    .select(FEATURE_SELECT)
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });
  if (featErr) {
    if (isMissingSchemaError(featErr)) return { ok: true, degraded: true, features: [], assignments: [] };
    throw featErr;
  }

  const { data: assignRows, error: assignErr } = await supabase
    .from(TABELA_ASSIGN)
    .select(ASSIGN_SELECT)
    .eq("scope", "plan");
  const assignments = assignErr ? [] : (assignRows ?? []).map(mapAssignment);

  return { ok: true, features: (featRows ?? []).map(mapFeature), assignments };
}

/**
 * Cria uma nova feature no catálogo (S1_4.1).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} body
 * @param {{ id?: string|null; name?: string|null }} operador
 */
export async function criarFeatureAdmin(supabase, body, operador) {
  const label = body.label != null ? String(body.label).trim() : "";
  if (!label) return { ok: false, error: { code: "INVALID_INPUT", message: "Nome da feature é obrigatório" } };

  const featureKey = gerarFeatureKey(body.feature_key, label);
  if (!FEATURE_KEY_RE.test(featureKey)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Chave da feature inválida (use a-z, 0-9, _)" } };
  }

  const status = STATUS_VALIDOS.includes(String(body.status)) ? String(body.status) : "ativa";
  const rollout = ROLLOUT_VALIDOS.includes(String(body.rollout_stage)) ? String(body.rollout_stage) : "ga";

  // Próxima ordem = maior + 10 (best-effort).
  const { data: ultima } = await supabase
    .from(TABELA_FEATURES)
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sortOrder = (Number(ultima?.sort_order) || 0) + 10;

  const row = {
    feature_key: featureKey,
    label,
    description: body.description != null ? String(body.description) : "",
    category: body.category != null && String(body.category).trim() ? String(body.category).trim() : "geral",
    status,
    rollout_stage: rollout,
    sort_order: sortOrder,
  };

  const { data: created, error } = await supabase.from(TABELA_FEATURES).insert(row).select(FEATURE_SELECT).maybeSingle();
  if (error) {
    if (String(error.code) === "23505") {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Já existe uma feature com essa chave" } };
    }
    console.error("[dev-center][admin-features] criar", error.message);
    return { ok: false, error: { code: "DB_ERROR", message: "Erro ao criar feature" } };
  }

  await registrarAuditoriaAdmin(supabase, {
    entity: "feature",
    entityId: created ? String(created.id) : featureKey,
    operationType: "feature_created",
    isCritical: false,
    field: "feature",
    before: null,
    after: { feature_key: featureKey, label, status, rollout_stage: rollout },
    operador,
    origin: ORIGIN,
  });

  return { ok: true, feature: created ? mapFeature(created) : null };
}

/**
 * Atualiza uma feature (label/descrição/categoria/status/rollout/ordem).
 * Status (S1_4.3/S1_4.4) é operação crítica.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} featureId
 * @param {Record<string, unknown>} body
 * @param {{ id?: string|null; name?: string|null }} operador
 */
export async function atualizarFeatureAdmin(supabase, featureId, body, operador) {
  const { data: atual, error: getErr } = await supabase
    .from(TABELA_FEATURES)
    .select(FEATURE_SELECT)
    .eq("id", featureId)
    .maybeSingle();
  if (getErr || !atual) return { ok: false, error: { code: "NOT_FOUND", message: "Feature não encontrada" } };

  const patch = {};
  /** @type {Array<{ field: string; before: unknown; after: unknown; operationType?: string; critical?: boolean }>} */
  const changes = [];

  if (body.label != null) {
    const novo = String(body.label).trim();
    if (!novo) return { ok: false, error: { code: "INVALID_INPUT", message: "Nome não pode ser vazio" } };
    if (novo !== atual.label) {
      patch.label = novo;
      changes.push({ field: "label", before: atual.label, after: novo, operationType: "feature_updated" });
    }
  }

  if (body.description !== undefined) {
    const nova = body.description != null ? String(body.description) : "";
    if (nova !== (atual.description ?? "")) {
      patch.description = nova;
      changes.push({ field: "description", before: atual.description ?? "", after: nova, operationType: "feature_updated" });
    }
  }

  if (body.category !== undefined) {
    const nova = body.category != null && String(body.category).trim() ? String(body.category).trim() : "geral";
    if (nova !== (atual.category ?? "geral")) {
      patch.category = nova;
      changes.push({ field: "category", before: atual.category ?? "geral", after: nova, operationType: "feature_updated" });
    }
  }

  if (body.status !== undefined) {
    const novo = String(body.status).trim().toLowerCase();
    if (!STATUS_VALIDOS.includes(novo)) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Status inválido" } };
    }
    if (novo !== atual.status) {
      patch.status = novo;
      // Habilitar/desabilitar feature global = operação crítica (S1_5.4).
      changes.push({ field: "status", before: atual.status, after: novo, operationType: "feature_status_changed", critical: true });
    }
  }

  if (body.rollout_stage !== undefined) {
    const novo = String(body.rollout_stage).trim().toLowerCase();
    if (!ROLLOUT_VALIDOS.includes(novo)) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Estágio de rollout inválido" } };
    }
    if (novo !== atual.rollout_stage) {
      patch.rollout_stage = novo;
      changes.push({ field: "rollout_stage", before: atual.rollout_stage, after: novo, operationType: "feature_rollout_changed" });
    }
  }

  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Ordem inválida" } };
    }
    if (n !== Number(atual.sort_order)) {
      patch.sort_order = n;
      changes.push({ field: "sort_order", before: Number(atual.sort_order), after: n, operationType: "feature_updated" });
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Nenhum campo válido para atualizar" } };
  }

  patch.updated_at = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from(TABELA_FEATURES)
    .update(patch)
    .eq("id", featureId)
    .select(FEATURE_SELECT)
    .maybeSingle();
  if (error) {
    console.error("[dev-center][admin-features] atualizar", error.message);
    return { ok: false, error: { code: "DB_ERROR", message: "Erro ao atualizar feature" } };
  }

  await registrarAuditoriaAdminLote(supabase, {
    entity: "feature",
    entityId: featureId,
    origin: ORIGIN,
    operador,
    changes,
  });

  return { ok: true, feature: updated ? mapFeature(updated) : null };
}

/**
 * Define o vínculo feature × escopo (upsert). Usado para Plano (S1_4.2).
 * Desabilitar vínculo é classificado como operação crítica.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} featureId
 * @param {Record<string, unknown>} body
 * @param {{ id?: string|null; name?: string|null }} operador
 */
export async function definirVinculoFeatureAdmin(supabase, featureId, body, operador) {
  const scope = String(body.scope ?? "plan").trim().toLowerCase();
  if (!SCOPES_VALIDOS.includes(scope)) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Escopo inválido" } };
  }
  const scopeId = body.scope_id != null && String(body.scope_id).trim() ? String(body.scope_id).trim() : null;
  if (scope !== "global" && !scopeId) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Alvo do escopo é obrigatório" } };
  }
  const enabled = Boolean(body.enabled);

  // Garante feature existente.
  const { data: feature, error: featErr } = await supabase
    .from(TABELA_FEATURES)
    .select("id, feature_key, label")
    .eq("id", featureId)
    .maybeSingle();
  if (featErr || !feature) return { ok: false, error: { code: "NOT_FOUND", message: "Feature não encontrada" } };

  // Procura vínculo existente (índice único é por expressão; resolvemos manualmente).
  let existingQuery = supabase
    .from(TABELA_ASSIGN)
    .select("id, enabled")
    .eq("feature_id", featureId)
    .eq("scope", scope);
  existingQuery = scopeId ? existingQuery.eq("scope_id", scopeId) : existingQuery.is("scope_id", null);
  const { data: existing } = await existingQuery.maybeSingle();

  const previousEnabled = existing ? existing.enabled !== false : null;
  const now = new Date().toISOString();

  let resultRow = null;
  if (existing) {
    const { data, error } = await supabase
      .from(TABELA_ASSIGN)
      .update({ enabled, updated_at: now })
      .eq("id", existing.id)
      .select(ASSIGN_SELECT)
      .maybeSingle();
    if (error) {
      console.error("[dev-center][admin-features] vinculo update", error.message);
      return { ok: false, error: { code: "DB_ERROR", message: "Erro ao atualizar vínculo" } };
    }
    resultRow = data;
  } else {
    const { data, error } = await supabase
      .from(TABELA_ASSIGN)
      .insert({ feature_id: featureId, scope, scope_id: scopeId, enabled })
      .select(ASSIGN_SELECT)
      .maybeSingle();
    if (error) {
      console.error("[dev-center][admin-features] vinculo insert", error.message);
      return { ok: false, error: { code: "DB_ERROR", message: "Erro ao criar vínculo" } };
    }
    resultRow = data;
  }

  await registrarAuditoriaAdmin(supabase, {
    entity: "feature_assignment",
    entityId: featureId,
    operationType: "feature_plan_link",
    isCritical: !enabled, // desligar acesso é crítico
    field: `${scope}:${scopeId ?? "global"}`,
    before: { enabled: previousEnabled },
    after: { enabled, feature_key: feature.feature_key },
    operador,
    origin: ORIGIN,
  });

  return { ok: true, assignment: resultRow ? mapAssignment(resultRow) : null };
}
