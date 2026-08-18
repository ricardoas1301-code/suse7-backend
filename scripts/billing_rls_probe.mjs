/**
 * Probe confiável de RLS — evita falso positivo do pg_class via role bypass ambíguo.
 * Usa pg_class.relrowsecurity + fallback dump pattern.
 */
export function probeRlsPgCatalog(stdout) {
  const val = String(stdout || "").trim().toLowerCase();
  return val === "t" || val === "true";
}

export function sqlProbeRls(schema, table) {
  return `
SELECT COALESCE(
  (SELECT c.relrowsecurity
   FROM pg_catalog.pg_class c
   INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${schema}' AND c.relname = '${table}'
   LIMIT 1),
  false
)::text;`;
}

export function probeRlsFromDump(dumpText, table) {
  const patterns = [
    new RegExp(`ALTER TABLE "public"."${table}" ENABLE ROW LEVEL SECURITY`, "i"),
    new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"),
  ];
  return patterns.some((p) => p.test(dumpText || ""));
}

export function probeRlsCombined(psqlResult, dumpText, table) {
  const catalog = probeRlsPgCatalog(psqlResult?.stdout);
  const dump = probeRlsFromDump(dumpText, table);
  return {
    enabled: catalog && dump,
    catalog,
    dump,
    method: "pg_catalog.relrowsecurity AND dump ENABLE ROW LEVEL SECURITY",
  };
}

/** Self-test em shadow docker — RLS disabled FAIL, enabled PASS */
export function runRlsSelfTest(runSql) {
  const setup = `
DROP TABLE IF EXISTS public.__s7_rls_probe_test;
CREATE TABLE public.__s7_rls_probe_test (id int);
ALTER TABLE public.__s7_rls_probe_test DISABLE ROW LEVEL SECURITY;
`;
  const enable = `ALTER TABLE public.__s7_rls_probe_test ENABLE ROW LEVEL SECURITY;`;
  const check = sqlProbeRls("public", "__s7_rls_probe_test");
  const cleanup = `DROP TABLE IF EXISTS public.__s7_rls_probe_test;`;

  runSql(setup);
  const disabled = runSql(check, true);
  runSql(enable);
  const enabled = runSql(check, true);
  runSql(cleanup);

  return {
    disabled_reads_false: !probeRlsPgCatalog(disabled.stdout),
    enabled_reads_true: probeRlsPgCatalog(enabled.stdout),
    pass: !probeRlsPgCatalog(disabled.stdout) && probeRlsPgCatalog(enabled.stdout),
  };
}
