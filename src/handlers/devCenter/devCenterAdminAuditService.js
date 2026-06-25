// ======================================================
// Dev Center — Auditoria administrativa global (backend)
// ------------------------------------------------------
// Registra alterações administrativas (before/after por campo) na
// tabela devcenter_admin_audit, usando o cliente service-role.
//
// BEST-EFFORT: a ausência da tabela ou qualquer falha NUNCA bloqueia
// a operação principal. Preparado para multi-admin/auditoria global.
// ======================================================

const TABELA_AUDIT = "devcenter_admin_audit";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Operador inválido/ausente → null (mantém integridade da FK auth.users). */
function operatorIdSeguro(id) {
  return id && UUID_RE.test(String(id)) ? String(id) : null;
}

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

/**
 * Registra UMA alteração administrativa (best-effort).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   entity: string;
 *   entityId?: string | null;
 *   field?: string | null;
 *   before?: unknown;
 *   after?: unknown;
 *   operador?: { id?: string | null; name?: string | null };
 *   origin?: string;
 *   operationType?: string | null;
 *   isCritical?: boolean;
 * }} entrada
 * @returns {Promise<{ ok: boolean }>}
 */
export async function registrarAuditoriaAdmin(supabase, entrada) {
  const base = {
    entity: entrada.entity,
    entity_id: entrada.entityId ?? null,
    field: entrada.field ?? null,
    before_data: entrada.before ?? null,
    after_data: entrada.after ?? null,
    operator_name: entrada.operador?.name ?? "Sistema",
    operator_id: operatorIdSeguro(entrada.operador?.id),
    origin: entrada.origin ?? "dev_center_admin",
  };
  const full = {
    ...base,
    operation_type: entrada.operationType ?? null,
    is_critical: Boolean(entrada.isCritical),
  };

  try {
    let { error } = await supabase.from(TABELA_AUDIT).insert(full);
    // Fallback: colunas operation_type/is_critical ainda não migradas.
    if (error && isMissingSchemaError(error)) {
      ({ error } = await supabase.from(TABELA_AUDIT).insert(base));
    }
    if (error) {
      console.warn("[dev-center][admin-audit] registrar", entrada.entity, entrada.field, error?.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.warn("[dev-center][admin-audit] registrar throw", error?.message);
    return { ok: false };
  }
}

/**
 * Registra várias alterações de campo (uma linha por campo) — best-effort.
 * Cada change pode classificar operação/criticidade individualmente.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   entity: string;
 *   entityId?: string | null;
 *   origin?: string;
 *   operador?: { id?: string | null; name?: string | null };
 *   operationType?: string | null;
 *   isCritical?: boolean;
 *   changes: Array<{ field: string; before: unknown; after: unknown; operationType?: string; critical?: boolean }>;
 * }} lote
 */
export async function registrarAuditoriaAdminLote(supabase, lote) {
  if (!Array.isArray(lote.changes) || lote.changes.length === 0) return { ok: true };
  for (const change of lote.changes) {
    await registrarAuditoriaAdmin(supabase, {
      entity: lote.entity,
      entityId: lote.entityId,
      field: change.field,
      before: change.before,
      after: change.after,
      operador: lote.operador,
      origin: lote.origin,
      operationType: change.operationType ?? lote.operationType ?? `${lote.entity}_updated`,
      isCritical: change.critical ?? lote.isCritical ?? false,
    });
  }
  return { ok: true };
}

/**
 * Lista a auditoria administrativa recente (timeline) — best-effort.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ limit?: number; entity?: string | null; onlyCritical?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean; entries: object[]; degraded?: boolean }>}
 */
export async function listarAuditoriaAdmin(supabase, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(1, Number(opts.limit)), 500) : 100;
  try {
    let query = supabase
      .from(TABELA_AUDIT)
      .select(
        "id, entity, entity_id, field, before_data, after_data, operator_name, operator_id, origin, operation_type, is_critical, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (opts.entity) query = query.eq("entity", opts.entity);
    if (opts.onlyCritical) query = query.eq("is_critical", true);

    let { data, error } = await query;
    if (error && isMissingSchemaError(error)) {
      // Fallback sem colunas novas.
      let legacy = supabase
        .from(TABELA_AUDIT)
        .select("id, entity, entity_id, field, before_data, after_data, operator_name, operator_id, origin, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (opts.entity) legacy = legacy.eq("entity", opts.entity);
      ({ data, error } = await legacy);
      if (error) return { ok: false, entries: [], degraded: true };
      return { ok: true, degraded: true, entries: (data ?? []).map(mapAuditRow) };
    }
    if (error) return { ok: false, entries: [], degraded: true };
    return { ok: true, entries: (data ?? []).map(mapAuditRow) };
  } catch {
    return { ok: false, entries: [], degraded: true };
  }
}

/** @param {Record<string, unknown>} row */
function mapAuditRow(row) {
  return {
    id: String(row.id),
    entity: row.entity ?? null,
    entity_id: row.entity_id ?? null,
    field: row.field ?? null,
    before: row.before_data ?? null,
    after: row.after_data ?? null,
    operator_name: row.operator_name ?? "Sistema",
    operator_id: row.operator_id ?? null,
    origin: row.origin ?? null,
    operation_type: row.operation_type ?? null,
    is_critical: Boolean(row.is_critical),
    created_at: row.created_at ?? null,
  };
}
