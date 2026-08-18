/**
 * Validação semântica do índice marketplace_accounts_global_active_external_uidx.
 * Não depende da representação textual exata de pg_indexes.indexdef.
 */

const INDEX_NAME = "marketplace_accounts_global_active_external_uidx";
const EXPECTED_COLUMNS = ["marketplace", "external_seller_id"];

/**
 * Normaliza predicate/indexdef para comparação semântica.
 * Aceita 'removed' com ou sem cast explícito (::text, ::varchar, etc.).
 */
export function normalizarPredicateIndexdef(indexdef) {
  return String(indexdef || "")
    .toLowerCase()
    .replace(/\\"/g, "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .replace(/'::text\b/g, "'")
    .replace(/::text\b/g, "")
    .replace(/'::character varying\b/g, "'")
    .replace(/::character varying\b/g, "")
    .trim();
}

/**
 * Extrai colunas indexadas de indexdef CREATE UNIQUE INDEX ... ON ... (col1, col2).
 */
export function extrairColunasIndexdef(indexdef) {
  const m = String(indexdef || "").match(/\(\s*([^)]+)\s*\)\s*WHERE/i);
  if (!m) {
    const m2 = String(indexdef || "").match(/\(\s*([^)]+)\s*\)\s*;?\s*$/i);
    if (!m2) return [];
    return m2[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  }
  return m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
}

/**
 * Valida semanticamente o índice ML global unique.
 * @param {{ index_exists?: boolean, index_definition?: string, indexdef?: string }} input
 */
export function validarIndiceMlGlobalUnique(input = {}) {
  const indexdef = (input.index_definition || input.indexdef || "").trim();
  const normalized = normalizarPredicateIndexdef(indexdef);
  const columns = extrairColunasIndexdef(indexdef);

  const predicateOk = /where[\s(]*status\s+is\s+distinct\s+from\s+'removed'/i.test(normalized);

  const columnsOk =
    columns.length === EXPECTED_COLUMNS.length &&
    EXPECTED_COLUMNS.every((col, i) => columns[i]?.toLowerCase() === col);

  const uniqueOk = /create unique index/i.test(indexdef);
  const nameOk = new RegExp(INDEX_NAME, "i").test(indexdef);

  const pass =
    Boolean(input.index_exists !== false && indexdef.length > 0) &&
    uniqueOk &&
    nameOk &&
    columnsOk &&
    predicateOk;

  return {
    pass,
    index_name: INDEX_NAME,
    index_exists: input.index_exists !== false && indexdef.length > 0,
    unique: uniqueOk,
    columns,
    columns_ok: columnsOk,
    predicate_ok: predicateOk,
    predicate_normalized: normalized.match(/where.+$/i)?.[0] || null,
    index_definition: indexdef,
  };
}
