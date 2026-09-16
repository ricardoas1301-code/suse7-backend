// ======================================================
// Leituras agregadas do Dev Center — paginação completa, sem N+1 por seller.
// Somente SELECT. Sem escrita em banco compartilhado.
// ======================================================

const PAGE_SIZE = 1000;
const IN_CHUNK = 80;

/**
 * @param {unknown} error
 */
export function isMissingColumnError(error) {
  const msg = String(error && typeof error === "object" && "message" in error ? error.message : "").toLowerCase();
  const code = error && typeof error === "object" && "code" in error ? String(error.code ?? "") : "";
  return code === "42703" || msg.includes("column") || msg.includes("does not exist");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} table
 * @param {string} select
 * @param {string} traceId
 * @param {{ eq?: Record<string, string>; inFilter?: { column: string; values: string[] }; notNull?: string } } [opts]
 * @returns {Promise<{ rows: Record<string, unknown>[]; failed: boolean; error: unknown }>}
 */
export async function selectAllPagedResult(supabase, table, select, traceId, opts = {}) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const inFilter = opts.inFilter;
  const values = inFilter?.values?.filter(Boolean) ?? [];
  if (inFilter && values.length === 0) return { rows, failed: false, error: null };

  const chunks =
    inFilter && values.length > 0
      ? chunkArray(values, IN_CHUNK)
      : [null];

  for (const chunk of chunks) {
    let from = 0;
    for (;;) {
      let query = supabase.from(table).select(select);
      if (opts.eq) {
        for (const [col, val] of Object.entries(opts.eq)) {
          query = query.eq(col, val);
        }
      }
      if (inFilter && chunk) {
        query = query.in(inFilter.column, chunk);
      }
      if (opts.notNull) {
        query = query.not(opts.notNull, "is", null);
      }
      const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.warn("[dev-center-admin] paged_select_failed", {
          table,
          message: error.message,
          traceId,
        });
        return { rows, failed: true, error };
      }
      const page = Array.isArray(data) ? data : [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  return { rows, failed: false, error: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} table
 * @param {string} select
 * @param {string} traceId
 * @param {{ eq?: Record<string, string>; inFilter?: { column: string; values: string[] }; notNull?: string } } [opts]
 */
export async function selectAllPaged(supabase, table, select, traceId, opts = {}) {
  const { rows } = await selectAllPagedResult(supabase, table, select, traceId, opts);
  return rows;
}

/**
 * Tenta selects em ordem quando a coluna não existe. Falha real (não-schema) devolve failed.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} table
 * @param {string[]} selects
 * @param {string} traceId
 * @param {{ eq?: Record<string, string>; inFilter?: { column: string; values: string[] }; notNull?: string } } [opts]
 */
export async function selectAllPagedWithFallback(supabase, table, selects, traceId, opts = {}) {
  /** @type {{ rows: Record<string, unknown>[]; failed: boolean; error: unknown }} */
  let last = { rows: [], failed: true, error: null };
  for (const sel of selects) {
    last = await selectAllPagedResult(supabase, table, sel, traceId, opts);
    if (!last.failed) return last;
    if (!isMissingColumnError(last.error)) return last;
  }
  return last;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} table
 * @param {string} userId
 * @returns {Promise<number | null>}
 */
export async function exactCountByUser(supabase, table, userId) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) return null;
  return typeof count === "number" && Number.isFinite(count) ? Math.max(0, count) : 0;
}

/**
 * @param {string[]} items
 * @param {number} size
 */
function chunkArray(items, size) {
  /** @type {string[][]} */
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
