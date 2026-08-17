// ======================================================
// Dev Center — Documentação Viva: trilha histórica (backend)
// ------------------------------------------------------
// Persiste e lê a trilha before/after da Documentação Viva
// (tabela devcenter_doc_history) usando o cliente service-role.
//
// Escopo EXCLUSIVO: devcenter_doc_history. Best-effort no registro:
// falha ao gravar histórico NUNCA quebra a operação principal.
//
// Auditoria administrativa / multi-admin: a arquitetura já nasce
// preparada (operator_id/operator_name), sem implementar tudo agora.
// ======================================================

const TABELA_HISTORICO = "devcenter_doc_history";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Operador inválido/ausente → null (mantém integridade da FK auth.users). */
function operatorIdSeguro(id) {
  return id && UUID_RE.test(String(id)) ? String(id) : null;
}

/**
 * Registra uma entrada na trilha histórica (best-effort).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   domainId?: string | null;
 *   sectionId?: string | null;
 *   itemId?: string | null;
 *   operationType: string;
 *   label?: string;
 *   before?: unknown;
 *   after?: unknown;
 *   operador?: { id?: string | null; name?: string | null };
 * }} entrada
 */
export async function registrarHistoricoDoc(supabase, entrada) {
  try {
    const { error } = await supabase.from(TABELA_HISTORICO).insert({
      domain_id: entrada.domainId ?? null,
      section_id: entrada.sectionId ?? null,
      item_id: entrada.itemId ?? null,
      operation_type: entrada.operationType,
      label: entrada.label ?? "",
      before_data: entrada.before ?? null,
      after_data: entrada.after ?? null,
      operator_name: entrada.operador?.name ?? "Sistema",
      operator_id: operatorIdSeguro(entrada.operador?.id),
    });
    if (error) {
      console.warn("[dev-center][doc-viva] registrarHistoricoDoc", entrada.operationType, error?.message);
    }
  } catch (error) {
    console.warn("[dev-center][doc-viva] registrarHistoricoDoc throw", error?.message);
  }
}

/** Mapeia linha do banco → formato do frontend (timeline). */
function mapHistorico(row) {
  return {
    history_id: row.id,
    domain_id: row.domain_id,
    section_id: row.section_id,
    item_id: row.item_id,
    operation_type: row.operation_type,
    label: row.label ?? "",
    before: row.before_data ?? null,
    after: row.after_data ?? null,
    operator_name: row.operator_name ?? "Sistema",
    operator_id: row.operator_id ?? null,
    created_at: row.created_at,
  };
}

/**
 * Lista a trilha histórica (timeline). Mais recente primeiro.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ domainId?: string | null; limit?: number }} [filtro]
 * @returns {Promise<{ ok: true; history: object[]; degraded?: boolean }>}
 */
export async function listarHistoricoDoc(supabase, { domainId = null, limit = 200 } = {}) {
  let query = supabase
    .from(TABELA_HISTORICO)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (domainId) query = query.eq("domain_id", domainId);

  const { data, error } = await query;
  if (error) {
    // Tabela ausente (migration não aplicada) → degrada sem quebrar.
    if (
      String(error.code ?? "") === "42P01" ||
      String(error.message ?? "").toLowerCase().includes("does not exist")
    ) {
      return { ok: true, history: [], degraded: true };
    }
    throw error;
  }
  return { ok: true, history: (data ?? []).map(mapHistorico) };
}
