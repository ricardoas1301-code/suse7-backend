#!/usr/bin/env node
/**
 * DEV.CLEAN-ROOM.SUPER-METAL-RIO.DRYRUN.01
 *
 * Dry-run DEFAULT — read-only. Não executa DELETE/UPDATE.
 *
 * Uso:
 *   node scripts/dev_clean_room_reset_seller.mjs
 *   node scripts/dev_clean_room_reset_seller.mjs --execute   (bloqueado nesta missão)
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  DEV_CLEAN_ROOM_DENYLIST,
  SUPER_METAL_RIO_CNPJ,
  SUPER_METAL_RIO_CONTEXT_USER_IDS,
  SUPER_METAL_RIO_EXTERNAL_SELLER_ID,
  SUPER_METAL_RIO_MARKETPLACE_ACCOUNT_IDS,
  SUPER_METAL_RIO_SELLER_COMPANY_IDS,
  isDevCleanRoomDenylisted,
} from "../src/domain/dev/devCleanRoomMaintenanceFence.js";
import {
  extractSupabaseProjectRef,
  S7_SUPABASE_PROJECT_REF,
} from "../src/billing/services/billingRuntimeEnvironmentService.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "output");
const RUN_DATE = "2026-08-13";
const execute = process.argv.includes("--execute");

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const projectRef = extractSupabaseProjectRef(process.env);
if (projectRef === S7_SUPABASE_PROJECT_REF.PROD) {
  console.error("ABORT: project_ref PROD — dry-run só em DEV");
  process.exit(2);
}
if (projectRef !== S7_SUPABASE_PROJECT_REF.DEV) {
  console.error(`ABORT: project_ref inesperado (${projectRef ?? "null"}) — esperado DEV`);
  process.exit(2);
}

if (execute) {
  console.error("ABORT: --execute não autorizado nesta missão (DRY-RUN only)");
  process.exit(3);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const TARGETS = {
  mission: "DEV.CLEAN-ROOM.SUPER-METAL-RIO.DRYRUN.01",
  generated_at: new Date().toISOString(),
  project_ref: projectRef,
  razao_social: "SUPER METAL RIO LTDA",
  cnpj: SUPER_METAL_RIO_CNPJ,
  cnpj_confirmed_by_rico: true,
  external_seller_id: SUPER_METAL_RIO_EXTERNAL_SELLER_ID,
  seller_company_ids: [...SUPER_METAL_RIO_SELLER_COMPANY_IDS],
  marketplace_account_ids: [...SUPER_METAL_RIO_MARKETPLACE_ACCOUNT_IDS],
  context_user_ids: [...SUPER_METAL_RIO_CONTEXT_USER_IDS],
  denylist: DEV_CLEAN_ROOM_DENYLIST,
  external_auth_state: "EXTERNAL_AUTH_ABSENT",
  mode: "dry_run",
};

function outPath(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, name);
}

async function countExact(table, filterFn) {
  try {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    q = filterFn(q);
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: count ?? 0 };
  } catch (e) {
    return { count: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function countIn(table, column, values) {
  if (!values.length) return { count: 0 };
  return countExact(table, (q) => q.in(column, values));
}

async function sampleIds(table, column, values, limit = 5) {
  const { data, error } = await supabase.from(table).select("id").in(column, values).limit(limit);
  if (error) return { ids: [], error: error.message };
  return { ids: (data ?? []).map((r) => r.id) };
}

async function countProductsExclusiveToTargetAccounts() {
  const { data: listingRows, error: listErr } = await supabase
    .from("marketplace_listings")
    .select("product_id, marketplace_account_id")
    .in("marketplace_account_id", SUPER_METAL_RIO_MARKETPLACE_ACCOUNT_IDS)
    .not("product_id", "is", null);
  if (listErr) return { exclusive: null, shared: null, error: listErr.message };

  const productIds = [...new Set((listingRows ?? []).map((r) => r.product_id).filter(Boolean))];
  if (!productIds.length) return { exclusive: 0, shared: 0, product_ids_total: 0 };

  const { data: allLinks, error: linkErr } = await supabase
    .from("marketplace_listings")
    .select("product_id, marketplace_account_id")
    .in("product_id", productIds);
  if (linkErr) return { exclusive: null, shared: null, error: linkErr.message };

  const targetSet = new Set(SUPER_METAL_RIO_MARKETPLACE_ACCOUNT_IDS);
  let exclusive = 0;
  let shared = 0;
  const byProduct = new Map();
  for (const row of allLinks ?? []) {
    const pid = String(row.product_id);
    if (!byProduct.has(pid)) byProduct.set(pid, new Set());
    byProduct.get(pid).add(String(row.marketplace_account_id));
  }
  for (const [, accounts] of byProduct) {
    const onlyTarget = [...accounts].every((a) => targetSet.has(a));
    if (onlyTarget) exclusive += 1;
    else shared += 1;
  }
  return { exclusive, shared, product_ids_total: productIds.length };
}

async function buildInventory() {
  const accountIds = SUPER_METAL_RIO_MARKETPLACE_ACCOUNT_IDS;
  const companyIds = SUPER_METAL_RIO_SELLER_COMPANY_IDS;

  const rowCounts = {
    marketplace_accounts_by_external_seller: await countExact("marketplace_accounts", (q) =>
      q.eq("external_seller_id", SUPER_METAL_RIO_EXTERNAL_SELLER_ID),
    ),
    marketplace_accounts_by_id: await countIn("marketplace_accounts", "id", accountIds),
    ml_tokens_by_ml_user_id: await countExact("ml_tokens", (q) =>
      q.eq("ml_user_id", SUPER_METAL_RIO_EXTERNAL_SELLER_ID),
    ),
    seller_companies_by_cnpj: await countExact("seller_companies", (q) =>
      q.eq("document_cnpj", SUPER_METAL_RIO_CNPJ),
    ),
    seller_companies_by_id: await countIn("seller_companies", "id", companyIds),
    sales_orders: await countIn("sales_orders", "marketplace_account_id", accountIds),
    sales_order_items: await countIn("sales_order_items", "marketplace_account_id", accountIds),
    order_raw_snapshots: await countIn("order_raw_snapshots", "marketplace_account_id", accountIds),
    marketplace_listings: await countIn("marketplace_listings", "marketplace_account_id", accountIds),
    ml_webhook_events: await countIn("ml_webhook_events", "marketplace_account_id", accountIds),
    ml_webhook_events_by_seller: await countExact("ml_webhook_events", (q) =>
      q.or(`user_id.eq.${SUPER_METAL_RIO_EXTERNAL_SELLER_ID},marketplace_user_id.eq.${SUPER_METAL_RIO_EXTERNAL_SELLER_ID}`),
    ),
    marketplace_account_sync_jobs: await countIn("marketplace_account_sync_jobs", "marketplace_account_id", accountIds),
    competition_monitored_listings: await countIn("competition_monitored_listings", "marketplace_account_id", accountIds),
    billing_billable_sale_admissions: await countIn("billing_billable_sale_admissions", "marketplace_account_id", accountIds),
    billing_billable_sale_admissions_alt: await countIn("billing_seller_admissions", "marketplace_account_id", accountIds),
    products_linked_via_listings: await countProductsExclusiveToTargetAccounts(),
  };

  for (const accountId of accountIds) {
    rowCounts[`sales_orders@${accountId}`] = await countExact("sales_orders", (q) =>
      q.eq("marketplace_account_id", accountId),
    );
    rowCounts[`ml_webhook_events@${accountId}`] = await countExact("ml_webhook_events", (q) =>
      q.eq("marketplace_account_id", accountId),
    );
  }

  return rowCounts;
}

function classifyTables(rowCounts) {
  /** @type {Record<string, { classification: string; count: number | null; note?: string }>} */
  const classified = {};

  const safeDeleteKeys = [
    "sales_orders",
    "sales_order_items",
    "order_raw_snapshots",
    "marketplace_listings",
    "ml_webhook_events",
    "marketplace_account_sync_jobs",
    "competition_monitored_listings",
    "marketplace_accounts_by_id",
    "ml_tokens_by_ml_user_id",
    "seller_companies_by_id",
    "billing_billable_sale_admissions",
    "billing_billable_sale_admissions_alt",
  ];

  for (const key of safeDeleteKeys) {
    const entry = rowCounts[key];
    classified[key] = {
      classification: "SAFE_DELETE",
      count: entry?.count ?? null,
      note: entry?.error ?? undefined,
    };
  }

  classified.products_linked_via_listings = {
    classification:
      (rowCounts.products_linked_via_listings?.shared ?? 0) > 0 ? "SHARED_PRESERVE" : "SAFE_DELETE",
    count: rowCounts.products_linked_via_listings?.product_ids_total ?? null,
    note: `exclusive=${rowCounts.products_linked_via_listings?.exclusive ?? 0}; shared=${rowCounts.products_linked_via_listings?.shared ?? 0}`,
  };

  classified.profiles = {
    classification: "SHARED_PRESERVE",
    count: SUPER_METAL_RIO_CONTEXT_USER_IDS.length,
    note: "NÃO user wipe — contexto apenas",
  };

  classified.auth_users = {
    classification: "SHARED_PRESERVE",
    count: SUPER_METAL_RIO_CONTEXT_USER_IDS.length,
    note: "NÃO deletar auth.users nesta missão",
  };

  classified.billing_subscriptions_user_scoped = {
    classification: "SHARED_PRESERVE",
    count: null,
    note: "Subscriptions são user-level; preservar tenants multi-company",
  };

  classified.ml_webhook_events_audit = {
    classification: "FORENSIC_PRESERVE",
    count: rowCounts.ml_webhook_events?.count ?? null,
    note: "Logs históricos — preferir preserve se não causarem runtime pós-limpeza",
  };

  classified.denylist_smr_churrasqueiras = {
    classification: "SHARED_PRESERVE",
    count: 1,
    note: "Denylist absoluta — NÃO tocar",
  };

  return classified;
}

async function verifyDenylistUntouched() {
  const checks = [];
  for (const userId of DEV_CLEAN_ROOM_DENYLIST.user_ids) {
    const { count } = await countExact("marketplace_accounts", (q) => q.eq("user_id", userId));
    checks.push({ type: "denylist_user", id: userId, marketplace_accounts: count });
  }
  for (const accountId of DEV_CLEAN_ROOM_DENYLIST.marketplace_account_ids) {
    const { count } = await countExact("marketplace_accounts", (q) => q.eq("id", accountId));
    checks.push({ type: "denylist_account", id: accountId, exists: (count ?? 0) > 0 });
  }
  return checks;
}

async function main() {
  console.info("[clean-room] dry-run start", { project_ref: projectRef, execute });

  if (isDevCleanRoomDenylisted({ userId: DEV_CLEAN_ROOM_DENYLIST.user_ids[0] })) {
    console.info("[clean-room] denylist guard OK");
  }

  const [accountsRes, companiesRes, denylistChecks] = await Promise.all([
    supabase
      .from("marketplace_accounts")
      .select("id,user_id,seller_company_id,external_seller_id,account_alias,ml_nickname,status,created_at")
      .in("id", SUPER_METAL_RIO_MARKETPLACE_ACCOUNT_IDS),
    supabase
      .from("seller_companies")
      .select("id,user_id,document_cnpj,trade_name,company_name,created_at")
      .in("id", SUPER_METAL_RIO_SELLER_COMPANY_IDS),
    verifyDenylistUntouched(),
  ]);

  const rowCounts = await buildInventory();
  const classifications = classifyTables(rowCounts);
  const undecided = Object.entries(classifications)
    .filter(([, v]) => v.classification === "UNDECIDED")
    .map(([k]) => k);

  const dryRun = {
    ...TARGETS,
    accounts: accountsRes.data ?? [],
    accounts_error: accountsRes.error?.message ?? null,
    seller_companies: companiesRes.data ?? [],
    seller_companies_error: companiesRes.error?.message ?? null,
    denylist_verification: denylistChecks,
    row_counts: rowCounts,
    classifications,
    undecided,
    expected_zero_invariants_post_execute: {
      "marketplace_accounts.external_seller_id=677620487": 0,
      "ml_tokens.ml_user_id=677620487": 0,
      "seller_companies.document_cnpj=73151110000128": 0,
      runtime_sales_listings_account_state: 0,
    },
    impact_other_sellers_expected: "ZERO",
    novo_user_clean_room_plan: {
      strategy: "Criar NOVO usuário dedicado pós-limpeza",
      do_not_reuse: SUPER_METAL_RIO_CONTEXT_USER_IDS,
      onboarding_flow: [
        "signup",
        "profile",
        "company",
        "CNPJ",
        "billing state",
        "ML OAuth",
        "marketplace_account",
        "sync",
        "first natural sale",
      ],
      first_sale_expectation: {
        marketplace_accounts_for_677620487: 1,
        internal_provenance_class: "CAPTURED_AT_INGESTION",
      },
    },
    risks: [
      "products compartilhados entre accounts do mesmo user c8a62ec6",
      "billing/subscriptions user-level nos tenants legados",
      "webhooks pendentes podem continuar chegando (fence deve ignorar)",
      "syncMercadoLivreSingleOrderByAccountId ausente no export (bug pré-existente)",
    ],
    recommendation: "BLOQUEADO para execute — aguardar Rico. Pronto para A) commit/deploy fence + Provenance V2",
  };

  const targetsPath = outPath(`SUPER_METAL_RIO_CLEAN_ROOM_TARGETS_${RUN_DATE}.json`);
  const dryRunPath = outPath(`SUPER_METAL_RIO_CLEAN_ROOM_DRYRUN_${RUN_DATE}.json`);
  fs.writeFileSync(targetsPath, JSON.stringify(TARGETS, null, 2));
  fs.writeFileSync(dryRunPath, JSON.stringify(dryRun, null, 2));

  console.info("[clean-room] artifacts written", { targetsPath, dryRunPath });
  console.info("[clean-room] row_counts summary", JSON.stringify(rowCounts, null, 2));
  console.info("[clean-room] undecided", undecided.length ? undecided : "none");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
