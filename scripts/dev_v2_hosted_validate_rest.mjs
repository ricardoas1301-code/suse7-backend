#!/usr/bin/env node
/** Validate hosted DEV V2 via Supabase REST (no docker psql). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "output");
const RUN_DATE = "2026-08-13";
const PROJECT_REF = "alkelcaoexxbamqddaqv";
const BASE = `https://${PROJECT_REF}.supabase.co`;

function parseSupabaseJson(stdout) {
  const i = stdout.indexOf("[");
  if (i < 0) return null;
  const j = stdout.lastIndexOf("]");
  try { return JSON.parse(stdout.slice(i, j + 1)); } catch { return null; }
}

async function countTable(table, key) {
  const res = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });
  const range = res.headers.get("content-range") || "";
  const m = range.match(/\/(\d+)$/);
  return { status: res.status, count: m ? Number(m[1]) : null };
}

async function main() {
  const keysRaw = fs.readFileSync(path.join(OUT, "_api_keys.json"), "utf8");
  const keys = parseSupabaseJson(keysRaw);
  const service = keys.find((k) => /service_role/i.test(k.name))?.api_key;
  if (!service) throw new Error("service_role not found");

  const runtimeTables = [
    "profiles", "seller_companies", "marketplace_accounts", "products",
    "marketplace_listings", "sales_orders", "sales_order_items", "ml_webhook_events",
    "billing_subscriptions", "billing_customers", "billing_payment_methods",
    "s7_notification_recipients", "s7_operational_tasks", "legal_document_acceptances",
  ];
  const globalTables = [
    "s7_notification_categories", "s7_notification_event_types", "s7_notification_templates",
    "billing_notification_templates", "plans",
  ];
  const runtime = {};
  for (const t of runtimeTables) runtime[t] = (await countTable(t, service)).count;
  const global = {};
  for (const t of globalTables) global[t] = (await countTable(t, service)).count;

  const plans = await fetch(`${BASE}/rest/v1/plans?select=plan_key,sales_limit_monthly,price_cents&order=sort_order`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  const planRows = await plans.json();

  const storage = await fetch(`${BASE}/storage/v1/bucket/company-logos`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  const bucket = storage.ok ? await storage.json() : null;
  const objects = await countTable("objects", service).catch(() => ({ count: null }));

  const authUsers = await fetch(`${BASE}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  const authBody = authUsers.ok ? await authUsers.json() : null;
  const authCount = Array.isArray(authBody?.users) ? authBody.users.length : authBody?.total ?? null;

  const expectedGlobal = {
    s7_notification_categories: 11,
    s7_notification_event_types: 31,
    s7_notification_templates: 36,
    billing_notification_templates: 11,
    plans: 8,
  };
  const runtimeZero = Object.entries(runtime).every(([, c]) => c === 0 || c === null);
  const globalOk = Object.entries(expectedGlobal).every(([t, n]) => global[t] === n);
  const baby = planRows.find((p) => p.plan_key === "baby");

  const result = {
    runtime_counts: { ...runtime, auth_users: authCount },
    runtime_zero: runtimeZero && authCount === 0,
    global_counts: global,
    global_ok: globalOk,
    plans: planRows,
    plans_baby: baby,
    storage: {
      company_logos: bucket,
      pass: bucket?.public === true && bucket?.file_size_limit === 5242880,
    },
    pass: runtimeZero && globalOk && authCount === 0 && global.plans === 8 && baby?.sales_limit_monthly === 50 && (bucket?.public === true && bucket?.file_size_limit === 5242880),
  };

  fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_RUNTIME_ZERO_${RUN_DATE}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_GLOBAL_REFERENCE_BASELINE_${RUN_DATE}.json`),
    JSON.stringify({ expected: expectedGlobal, observed: global, pass: globalOk }, null, 2),
  );
  console.log(JSON.stringify({ pass: result.pass, runtime_zero: result.runtime_zero, global_ok: globalOk, plans: global.plans, auth_users: authCount }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
