#!/usr/bin/env node
/**
 * DEV.V2.CORE-SCHEMA-BOOTSTRAP.03 — gera timelines + contract JSON
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";
const BACKEND = path.join(__dirname, "..", "supabase", "migrations");
const FRONTEND = path.join(__dirname, "..", "..", "suse7-frontend", "supabase", "migrations");

function listMigs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

function scan(dir, pattern) {
  const hits = [];
  for (const f of listMigs(dir)) {
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    if (pattern.test(content)) hits.push({ file: f, repo: dir.includes("frontend") ? "suse7-frontend" : "suse7-backend" });
  }
  return hits;
}

const plansTimeline = {
  generated_at: new Date().toISOString(),
  birth: {
    location: "suse7-frontend/supabase/migrations/20260301215430_baseline_public_from_prod.sql",
    initial_pk: "name",
    initial_columns: ["name", "limit_pricings", "price", "tier"],
    classification: "CANONICAL_REQUIRED",
  },
  id_introduction: {
    when_should_exist: "before 20260209120000_s7_billing_core_billing03.sql",
    versioned_in_repo_before_bootstrap: false,
    bootstrap: "20260301220000_core_schema_bootstrap.sql",
    semantics: "uuid UNIQUE NOT NULL; PK remains name per DEV contract",
    classification: "CANONICAL_REQUIRED",
  },
  later_columns: [
    { column: "display_name, marketing_name, slug", migration: "20260513160000_s7_billing_042_limits_enforcement.sql", uses_plan_key: true },
    { column: "admin_status, description", migration: "20260602180000_dev_center_admin_plans.sql" },
    { column: "plan_key, is_active, sales_limit_monthly", migration: "NOT VERSIONED — LEGACY_DRIFT on DEV; required by 20260723140000 hardening", classification: "UNCERTAIN for fresh replay" },
  ],
  dependencies_on_id: scan(BACKEND, /REFERENCES public\.plans\s*\(\s*id\s*\)/i).map((h) => h.file),
  inserts_in_repo: [],
  rls: {
    baseline: ["plans_public_select", "plans_service_role"],
    later: "20260624120000 → s7_plans_authenticated_select_catalog",
  },
};

const sellerTimeline = {
  generated_at: new Date().toISOString(),
  birth: {
    versioned_create_before_bootstrap: false,
    bootstrap: "20260301220000_core_schema_bootstrap.sql",
    classification: "CANONICAL_REQUIRED",
  },
  initial_columns: [
    "id", "user_id", "company_name", "trade_name", "document_cnpj", "tax_regime",
    "default_tax_rate", "operational_cost_rate", "internal_notes", "phone", "whatsapp",
    "cep", "address_*", "logo_url", "is_primary", "active", "created_at", "updated_at", "contact_email",
  ],
  later_added_columns: [],
  initial_constraints: ["PRIMARY KEY (id)", "UNIQUE (user_id, document_cnpj)"],
  initial_indexes: ["seller_companies_user_id_idx", "seller_companies_user_document_uniq", "seller_companies_user_primary_idx"],
  first_required_by: {
    migration: "20260506102000_sales_multiconta_schema_hardening.sql",
    required_at_point: ["id uuid PK", "table exists for FK"],
  },
  alter_migrations: scan(BACKEND, /seller_companies/i),
  rls: {
    bootstrap: "ENABLE ROW LEVEL SECURITY",
    policies: "20260624120000_s7_rls_public_schema_hardening_s4.sql → s7_private.apply_user_id_tenant_rls",
  },
  fk_user_id_auth: "NOT PRESENT — intentional per DEV contract",
};

const marketplaceTimeline = {
  generated_at: new Date().toISOString(),
  birth: {
    versioned_create_before_bootstrap: false,
    bootstrap: "20260301220000_core_schema_bootstrap.sql",
    classification: "CANONICAL_REQUIRED",
  },
  initial_columns: [
    "id", "user_id", "seller_company_id", "marketplace", "external_seller_id",
    "account_alias", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at",
    "scope", "token_type", "ml_nickname", "status", "last_sync_at", "created_at", "updated_at",
    "ml_sales_last_sync_at", "ml_sales_last_synced_order_created_to",
  ],
  later_added_columns: [],
  initial_constraints: [
    "PRIMARY KEY (id)",
    "FK seller_company_id → seller_companies(id)",
    "UNIQUE (user_id, marketplace, external_seller_id)",
  ],
  first_required_by: {
    migration: "20260506102000_sales_multiconta_schema_hardening.sql",
    required_at_point: ["id uuid PK", "seller_company_id FK target"],
  },
  earlier_reference: {
    migration: "20260505183000 — marketplace_customers only",
    note: "marketplace_accounts first FK reference is 20260506102000",
  },
  alter_migrations: scan(BACKEND, /marketplace_accounts/i),
  rls: {
    bootstrap: "ENABLE ROW LEVEL SECURITY",
    policies: "20260624120000 → apply_user_id_tenant_rls('marketplace_accounts')",
  },
};

const coreContract = {
  generated_at: new Date().toISOString(),
  bootstrap_location: "suse7-frontend/supabase/migrations/20260301220000_core_schema_bootstrap.sql",
  bootstrap_position: "after baseline + sales bridge; before backend migrations",
  provisional_until: "INFRA.DB.REPLAY.SINGLE-ENTRYPOINT.01",
  sales_bridges: {
    "20260301215959_baseline_sales_schema_bridge.sql": {
      classification: "CANONICAL_BRIDGE",
      reason: "baseline sales legado order_id vs phase3 sales_order_id",
      fresh_only_safe: true,
      existing_env_risk: "low — guarded by empty tables + column check",
    },
    "20260328120001_sales_order_items_rpc_compat.sql": {
      classification: "CANONICAL_BRIDGE",
      reason: "RPC 20260208140000 references external_order_id before multiconta timestamp",
      fresh_only_safe: true,
      existing_env_risk: "low — ADD COLUMN IF NOT EXISTS",
    },
  },
  plans: {
    pk_final: "name",
    id_semantics: "uuid UNIQUE NOT NULL — FK target for billing; NOT primary key",
  },
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `DEV_V2_PLANS_EVOLUTION_TIMELINE_${RUN_DATE}.json`), JSON.stringify(plansTimeline, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_SELLER_COMPANIES_EVOLUTION_TIMELINE_${RUN_DATE}.json`), JSON.stringify(sellerTimeline, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_MARKETPLACE_ACCOUNTS_EVOLUTION_TIMELINE_${RUN_DATE}.json`), JSON.stringify(marketplaceTimeline, null, 2));
fs.writeFileSync(path.join(OUT, `DEV_V2_CORE_BOOTSTRAP_CONTRACT_${RUN_DATE}.json`), JSON.stringify(coreContract, null, 2));

console.log(JSON.stringify({ ok: true, artifacts: 4 }, null, 2));
