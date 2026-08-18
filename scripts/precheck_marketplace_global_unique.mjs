#!/usr/bin/env node
/**
 * Read-only precheck for global unique index — NÃO aplica migration.
 * Target Fresh DEV: alkelcaoexxbamqddaqv
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "../supabase/migrations/20260821120000_marketplace_accounts_global_ml_external_active_uidx.sql",
);

const migrationSql = readFileSync(migrationPath, "utf8");

const report = {
  mission: "DEV.V2.ML-OAUTH-ONBOARDING-M6-IMPLEMENTATION.01E-C",
  target_supabase: "alkelcaoexxbamqddaqv",
  migration_file: "20260821120000_marketplace_accounts_global_ml_external_active_uidx.sql",
  status_predicate: "status IS DISTINCT FROM 'removed'",
  status_semantics: {
    removed: "histórico desconectado — excluído do índice",
    null: "conta como vínculo ativo (DISTINCT FROM removed)",
    active: "vínculo ativo",
  },
  hosted_apply: "NOT_APPLIED_BY_DESIGN",
  duplicate_precheck: "SKIPPED_NO_SERVICE_ROLE_IN_SESSION",
  migration_sql_preview: migrationSql.trim().split("\n").slice(0, 6),
  recommendation: "Executar SELECT de duplicatas ativas no Fresh DEV antes de hosted push.",
};

console.log(JSON.stringify(report, null, 2));
