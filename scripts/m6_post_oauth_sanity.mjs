#!/usr/bin/env node
/** READ-ONLY — Sanity pós-OAuth real (Fresh DEV). Sem tokens/secrets. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELLER_ID = "5660a0d1-6105-4aaa-9835-6c8d9d54199c";
const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const EXPECTED_REF = "alkelcaoexxbamqddaqv";

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

function trunc(id) {
  if (!id) return null;
  const s = String(id);
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function refFrom(url) {
  try {
    return new URL(url).hostname.split(".")[0].toLowerCase();
  } catch {
    return null;
  }
}

async function main() {
  const env = { ...parseDotEnv(path.join(REPO, ".env")), ...parseDotEnv(path.join(REPO, ".env.local")) };
  const adm = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date().toISOString();

  const { data: maRows } = await adm
    .from("marketplace_accounts")
    .select("id, status, marketplace, external_seller_id, seller_company_id, user_id, created_at, updated_at")
    .eq("user_id", USER_ID)
    .eq("marketplace", "mercado_livre")
    .order("created_at", { ascending: false });

  const accounts = Array.isArray(maRows) ? maRows : [];
  const active = accounts.filter((r) => String(r.status ?? "").trim().toLowerCase() !== "removed");

  const { data: tokens } = await adm
    .from("ml_tokens")
    .select("id, user_id, ml_user_id, marketplace_account_id, marketplace, updated_at")
    .eq("user_id", USER_ID)
    .order("updated_at", { ascending: false })
    .limit(5);

  const { data: states } = await adm
    .from("oauth_states")
    .select("state, expires_at, user_id, seller_company_id")
    .eq("user_id", USER_ID)
    .eq("marketplace", "mercado_livre")
    .gt("expires_at", now);

  const { data: profile } = await adm
    .from("profiles")
    .select(
      "id, first_marketplace_connected_at, initial_configuration_completed_at, telefone, avatar_url, operational_cycle_configured_at",
    )
    .eq("id", USER_ID)
    .maybeSingle();

  let jobsCount = null;
  try {
    const { count } = await adm
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", USER_ID);
    jobsCount = count;
  } catch {
    jobsCount = "unknown";
  }

  let syncJobs = null;
  for (const table of ["marketplace_sync_jobs", "sync_jobs", "job_queue"]) {
    try {
      const { count, error } = await adm.from(table).select("id", { count: "exact", head: true }).limit(1);
      if (!error) {
        syncJobs = { table, count };
        break;
      }
    } catch {
      /* skip */
    }
  }

  const report = {
    generatedAt: now,
    projectRef: refFrom(env.SUPABASE_URL),
    marketplaceAccounts: {
      total: accounts.length,
      active: active.length,
      rows: active.map((r) => ({
        idTrunc: trunc(r.id),
        status: r.status,
        externalSellerIdTrunc: r.external_seller_id ? `${String(r.external_seller_id).slice(0, 4)}…` : null,
        sellerCompanyMatch: String(r.seller_company_id || "").toLowerCase() === SELLER_ID.toLowerCase(),
        userMatch: String(r.user_id || "").toLowerCase() === USER_ID.toLowerCase(),
        createdAt: r.created_at,
      })),
    },
    mlTokens: {
      count: Array.isArray(tokens) ? tokens.length : 0,
      rows: (tokens || []).map((t) => ({
        idTrunc: trunc(t.id),
        mlUserIdTrunc: t.ml_user_id ? `${String(t.ml_user_id).slice(0, 4)}…` : null,
        marketplaceAccountIdTrunc: trunc(t.marketplace_account_id),
      })),
    },
    oauthStatesActive: Array.isArray(states) ? states.length : 0,
    profileLatches: {
      firstMarketplaceConnectedAt: profile?.first_marketplace_connected_at ?? null,
      initialConfigurationCompletedAt: profile?.initial_configuration_completed_at ?? null,
      telefonePresent: Boolean(String(profile?.telefone ?? "").trim()),
      avatarPresent: Boolean(String(profile?.avatar_url ?? "").trim()),
    },
    duplicateActiveExternal: active.length > 1,
    jobsProbe: { userJobsCount: jobsCount, syncJobsProbe: syncJobs },
  };

  const out = path.resolve(REPO, "../scripts/output/M6_POST_OAUTH_SANITY_2026-08-16.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
