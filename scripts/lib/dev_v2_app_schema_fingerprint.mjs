/**
 * App-owned schema fingerprint V2 — public + s7_private (excludes Supabase platform internals).
 */

/** SQL that returns a single md5 fingerprint line. */
export const APP_SCHEMA_FINGERPRINT_V2_SQL = `
WITH app_schemas AS (
  SELECT unnest(ARRAY['public', 's7_private']::text[]) AS nspname
),
table_cols AS (
  SELECT
    'table_cols:' || n.nspname || '.' || c.relname || ':' ||
    md5(string_agg(
      a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) ||
      ':' || CASE WHEN a.attnotnull THEN 'NN' ELSE 'NULL' END,
      ',' ORDER BY a.attnum
    )) AS line
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname IN (SELECT nspname FROM app_schemas)
    AND c.relkind = 'r'
    AND a.attnum > 0 AND NOT a.attisdropped
  GROUP BY n.nspname, c.relname
),
constraints AS (
  SELECT
    'constraint:' || n.nspname || '.' || con.conname || ':' ||
    con.contype::text || ':' || pg_get_constraintdef(con.oid, true) AS line
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN (SELECT nspname FROM app_schemas)
),
indexes AS (
  SELECT
    'index:' || n.nspname || '.' || ic.relname || ':' ||
    pg_get_indexdef(i.indexrelid) AS line
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN (SELECT nspname FROM app_schemas)
    AND NOT i.indisprimary
),
functions AS (
  SELECT
    'function:' || n.nspname || '.' || p.proname || '(' ||
    pg_get_function_identity_arguments(p.oid) || '):' ||
    CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ':' ||
    COALESCE(
      (SELECT string_agg(cfg, ';' ORDER BY cfg)
       FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg
       WHERE cfg LIKE 'search_path=%'),
      'search_path=unset'
    ) AS line
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN (SELECT nspname FROM app_schemas)
    AND p.prokind = 'f'
),
function_grants AS (
  SELECT
    'grant_fn:' || n.nspname || '.' || p.proname || ':' ||
    r.rolname || ':' ||
    CASE WHEN has_function_privilege(r.oid, p.oid, 'EXECUTE') THEN 'EXECUTE' ELSE 'NONE' END AS line
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) r
  WHERE n.nspname IN (SELECT nspname FROM app_schemas)
    AND p.prokind = 'f'
    AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
),
rls AS (
  SELECT
    'rls:' || n.nspname || '.' || c.relname || ':' ||
    CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END AS line
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
),
policies AS (
  SELECT
    'policy:' || pol.polname || ':' || n.nspname || '.' || c.relname || ':' ||
    pol.polcmd::text || ':' || pg_get_expr(pol.polqual, pol.polrelid) || ':' ||
    pg_get_expr(pol.polwithcheck, pol.polrelid) AS line
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
),
all_lines AS (
  SELECT line FROM table_cols
  UNION ALL SELECT line FROM constraints
  UNION ALL SELECT line FROM indexes
  UNION ALL SELECT line FROM functions
  UNION ALL SELECT line FROM function_grants
  UNION ALL SELECT line FROM rls
  UNION ALL SELECT line FROM policies
)
SELECT md5(string_agg(line, '|' ORDER BY line)) AS app_schema_fingerprint_v2
FROM all_lines;
`;

/** @deprecated Legacy fingerprint — public relnames + owners only (incomplete). */
export const LEGACY_SCHEMA_FINGERPRINT_SQL = `
SELECT md5(string_agg(c.relname || ':' || pg_catalog.pg_get_userbyid(c.relowner), ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','i','S','v','m');
`;

/**
 * @param {{ psql: (sql: string) => { status: number; stdout: string } }} deps
 */
export function computeAppSchemaFingerprintV2(deps) {
  const r = deps.psql(APP_SCHEMA_FINGERPRINT_V2_SQL);
  if (r.status !== 0) return { ok: false, fingerprint: null, error: r.stdout };
  const m = r.stdout.match(/([a-f0-9]{32})/);
  return { ok: true, fingerprint: m ? m[1] : r.stdout.trim() };
}

/**
 * @param {{ order: number; path: string; sha256: string; timestamp?: string }[]} chainMeta
 * @param {(text: string) => string} sha256Fn
 */
export function computeMigrationManifestFingerprint(chainMeta, sha256Fn) {
  const lines = chainMeta
    .map((item) => {
      const base = item.path.split(/[/\\]/).pop() ?? item.path;
      const ts = item.timestamp ?? base.split("_")[0];
      return `${String(item.order).padStart(4, "0")}:${ts}:${item.sha256}:${base}`;
    })
    .join("\n");
  return sha256Fn(lines);
}
