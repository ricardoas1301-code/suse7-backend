// ======================================================
// Dev Center — Gestão Administrativa de Planos (backend)
// ------------------------------------------------------
// Lê e edita o catálogo público de planos (public.plans) de forma
// administrativa e segura. Toda validação acontece aqui (service-role).
//
// REGRAS:
//  - Valores financeiros NUNCA usam float: price_monthly é validado como
//    string decimal e persistido como string (coluna numeric).
//  - NÃO altera billing/assinatura do seller, checkout ou consumo mensal.
//  - NÃO exclui planos fisicamente (apenas status administrativo).
//  - Auditoria é best-effort (não bloqueia a operação).
//  - Compatível com schema sem as colunas admin (fallback legacy).
// ======================================================

import { registrarAuditoriaAdminLote } from "./devCenterAdminAuditService.js";

const TABELA_PLANOS = "plans";
const ORIGIN = "dev_center_admin_plans";

const PLAN_SELECT =
  "id, plan_key, name, display_name, marketing_name, slug, price_monthly, sales_limit_monthly, billing_required, is_active, sort_order, admin_status, description";
const PLAN_SELECT_LEGACY =
  "id, plan_key, name, display_name, marketing_name, slug, price_monthly, sales_limit_monthly, billing_required, is_active, sort_order";

const STATUS_VALIDOS = ["ativo", "inativo", "futuro", "interno"];

/** Erro de schema ausente (coluna/tabela inexistente / cache). */
function isMissingSchemaError(error) {
  const code = String(error?.code ?? "");
  const msg = String(error?.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find")
  );
}

/** Status administrativo efetivo (deriva de is_active/billing_required se vazio). */
function statusEfetivo(row) {
  const adm = row?.admin_status != null ? String(row.admin_status).toLowerCase() : "";
  if (STATUS_VALIDOS.includes(adm)) return adm;
  if (row?.is_active === false) return "inativo";
  if (row?.billing_required === false) return "interno";
  return "ativo";
}

/** Mapeia linha do banco → shape do frontend (somente leitura). */
function mapPlanAdmin(row) {
  return {
    id: String(row.id),
    plan_key: row.plan_key ?? null,
    name: row.name ?? "",
    display_name: row.display_name ?? null,
    marketing_name: row.marketing_name ?? null,
    slug: row.slug ?? row.plan_key ?? null,
    // financeiro como string — frontend só exibe (sem float)
    price_monthly: row.price_monthly != null ? String(row.price_monthly) : null,
    sales_limit_monthly:
      row.sales_limit_monthly != null && Number.isFinite(Number(row.sales_limit_monthly))
        ? Number(row.sales_limit_monthly)
        : null,
    status: statusEfetivo(row),
    description: row.description ?? "",
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    billing_required: row.billing_required !== false,
    is_active: row.is_active !== false,
    is_internal: row.billing_required === false,
  };
}

/** SELECT com fallback de schema (com/sem colunas admin). */
async function selectPlans(supabase, filtroId = null) {
  const aplicar = (q) => (filtroId ? q.eq("id", filtroId) : q);
  let { data, error } = await aplicar(
    supabase.from(TABELA_PLANOS).select(PLAN_SELECT).order("sort_order", { ascending: true, nullsFirst: false }),
  );
  if (error && isMissingSchemaError(error)) {
    ({ data, error } = await aplicar(
      supabase
        .from(TABELA_PLANOS)
        .select(PLAN_SELECT_LEGACY)
        .order("sort_order", { ascending: true, nullsFirst: false }),
    ));
  }
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/**
 * Lista o catálogo completo de planos (ativos e inativos) para administração.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<{ ok: true; plans: object[] }>}
 */
export async function listarPlanosAdmin(supabase) {
  const rows = await selectPlans(supabase);
  return { ok: true, plans: rows.map(mapPlanAdmin) };
}

// ------------------------------------------------------
// Validação de entrada (sem float em valores financeiros)
// ------------------------------------------------------

/** Valida valor mensal como string decimal (até 2 casas). Retorna string ou null se inválido. */
function normalizarPrecoMensal(valor) {
  if (valor == null) return { invalido: true };
  const s = String(valor).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { invalido: true };
  // normaliza para 2 casas como string, sem usar float em cálculo
  const [inteiro, dec = ""] = s.split(".");
  const decimais = (dec + "00").slice(0, 2);
  return { valor: `${String(Number.parseInt(inteiro, 10))}.${decimais}` };
}

/** Valida limite mensal de vendas: inteiro >= 0 ou null (ilimitado). */
function normalizarLimiteVendas(valor) {
  if (valor === null || valor === "" || valor === undefined) return { valor: null };
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0) return { invalido: true };
  return { valor: n };
}

/**
 * Atualiza um plano (nome, valor, limite, descrição, status, ordem).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planId
 * @param {Record<string, unknown>} body
 * @param {{ id?: string|null; name?: string|null }} operador
 */
export async function atualizarPlanoAdmin(supabase, planId, body, operador) {
  const rows = await selectPlans(supabase, planId);
  const atual = rows[0];
  if (!atual) return { ok: false, error: { code: "NOT_FOUND", message: "Plano não encontrado" } };

  const patch = {};
  /** @type {Array<{ field: string; before: unknown; after: unknown }>} */
  const changes = [];

  // Nome comercial (sincroniza display_name/marketing_name para refletir o rótulo).
  if (body.name != null) {
    const novo = String(body.name).trim();
    if (!novo) return { ok: false, error: { code: "INVALID_INPUT", message: "Nome não pode ser vazio" } };
    if (novo !== atual.name) {
      patch.name = novo;
      patch.display_name = novo;
      patch.marketing_name = novo;
      changes.push({ field: "name", before: atual.name, after: novo });
    }
  }

  // Valor mensal (decimal seguro, sem float).
  if (body.price_monthly !== undefined) {
    const r = normalizarPrecoMensal(body.price_monthly);
    if (r.invalido) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Valor mensal inválido (use formato 0.00)" } };
    }
    const atualStr = atual.price_monthly != null ? String(atual.price_monthly) : null;
    if (r.valor !== atualStr) {
      patch.price_monthly = r.valor;
      changes.push({ field: "price_monthly", before: atualStr, after: r.valor, operationType: "plan_price_changed", critical: true });
    }
  }

  // Limite mensal de vendas (config do plano; sem cálculo de consumo aqui).
  if (body.sales_limit_monthly !== undefined) {
    const r = normalizarLimiteVendas(body.sales_limit_monthly);
    if (r.invalido) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Limite de vendas inválido" } };
    }
    const atualLimite = atual.sales_limit_monthly != null ? Number(atual.sales_limit_monthly) : null;
    if (r.valor !== atualLimite) {
      patch.sales_limit_monthly = r.valor;
      changes.push({ field: "sales_limit_monthly", before: atualLimite, after: r.valor, operationType: "plan_limit_changed", critical: true });
    }
  }

  // Descrição comercial.
  if (body.description !== undefined) {
    const nova = body.description != null ? String(body.description) : "";
    if (nova !== (atual.description ?? "")) {
      patch.description = nova;
      changes.push({ field: "description", before: atual.description ?? "", after: nova });
    }
  }

  // Status administrativo (sincroniza is_active sem mexer em regras de billing).
  if (body.status !== undefined) {
    const novo = body.status != null ? String(body.status).trim().toLowerCase() : "";
    if (!STATUS_VALIDOS.includes(novo)) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Status inválido" } };
    }
    const statusAtual = statusEfetivo(atual);
    if (novo !== statusAtual) {
      patch.admin_status = novo;
      // Coerência com billing: ativo/interno ficam ativos; inativo/futuro inativos.
      patch.is_active = novo === "ativo" || novo === "interno";
      changes.push({ field: "status", before: statusAtual, after: novo, operationType: "plan_status_changed", critical: true });
    }
  }

  // Ordem de exibição.
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Ordem inválida" } };
    }
    const atualOrdem = Number.isFinite(Number(atual.sort_order)) ? Number(atual.sort_order) : 0;
    if (n !== atualOrdem) {
      patch.sort_order = n;
      changes.push({ field: "sort_order", before: atualOrdem, after: n });
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Nenhum campo válido para atualizar" } };
  }

  // Persiste com fallback de schema (caso admin_status/description não existam ainda).
  let { error } = await supabase.from(TABELA_PLANOS).update(patch).eq("id", planId);
  if (error && isMissingSchemaError(error) && ("admin_status" in patch || "description" in patch)) {
    const patchLegacy = { ...patch };
    delete patchLegacy.admin_status;
    delete patchLegacy.description;
    if (Object.keys(patchLegacy).length > 0) {
      ({ error } = await supabase.from(TABELA_PLANOS).update(patchLegacy).eq("id", planId));
    } else {
      error = null;
    }
  }
  if (error) {
    console.error("[dev-center][admin-plans] update", { planId, message: error.message });
    return { ok: false, error: { code: "DB_ERROR", message: "Erro ao atualizar plano" } };
  }

  // Auditoria best-effort (não bloqueia).
  await registrarAuditoriaAdminLote(supabase, {
    entity: "plan",
    entityId: planId,
    origin: ORIGIN,
    operador,
    changes,
  });

  // Retorna o plano atualizado.
  const atualizado = await selectPlans(supabase, planId);
  return { ok: true, plan: atualizado[0] ? mapPlanAdmin(atualizado[0]) : null };
}
