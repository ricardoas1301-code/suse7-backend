#!/usr/bin/env node
/**
 * READ-ONLY — Sanity pré-autorização OAuth M6 (Fresh DEV alkel…).
 * Não autoriza, não troca code, não altera banco.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELLER_ID = "5660a0d1-6105-4aaa-9835-6c8d9d54199c";
const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const VERCEL_HOST = "https://suse7-backend-dev.vercel.app";

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = val;
  }
  return out;
}

function projectRefFromUrl(url) {
  try {
    return new URL(url).hostname.split(".")[0].toLowerCase();
  } catch {
    return null;
  }
}

function maskState(s) {
  if (!s) return null;
  const x = String(s);
  if (x.length <= 12) return `${x.slice(0, 4)}…`;
  return `${x.slice(0, 6)}…${x.slice(-4)}`;
}

function truncateId(id) {
  if (!id) return null;
  const s = String(id);
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

async function main() {
  const env = { ...parseDotEnv(path.join(REPO, ".env")), ...parseDotEnv(path.join(REPO, ".env.local")) };
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const ref = projectRefFromUrl(supabaseUrl);

  if (!supabaseUrl || !serviceKey) {
    console.error(JSON.stringify({ error: "missing_supabase_credentials" }));
    process.exit(1);
  }

  const adm = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();

  /** @type {Record<string, unknown>[]} */
  let states = [];
  for (const cols of [
    "state, user_id, seller_company_id, flow_type, expires_at, marketplace, created_at",
    "state, user_id, seller_company_id, flow_type, expires_at, marketplace",
    "state, user_id, seller_company_id, expires_at, marketplace",
    "state, user_id, expires_at, marketplace",
  ]) {
    const { data, error } = await adm
      .from("oauth_states")
      .select(cols)
      .eq("marketplace", "ml")
      .eq("user_id", USER_ID)
      .order("expires_at", { ascending: false })
      .limit(5);
    if (!error) {
      states = data ?? [];
      break;
    }
  }

  const activeStates = states.filter((r) => r.expires_at && new Date(String(r.expires_at)) > now);
  const latest = activeStates[0] ?? states[0] ?? null;

  const notExpired = latest?.expires_at ? new Date(String(latest.expires_at)) > now : false;
  const msToExpiry = latest?.expires_at ? new Date(String(latest.expires_at)).getTime() - now.getTime() : null;
  const createdRecently = msToExpiry != null && msToExpiry > 0 && msToExpiry <= 16 * 60 * 1000;

  const sellerMatch =
    latest?.seller_company_id != null
      ? String(latest.seller_company_id).toLowerCase() === SELLER_ID.toLowerCase()
      : null;
  const userMatch =
    latest?.user_id != null ? String(latest.user_id).toLowerCase() === USER_ID.toLowerCase() : false;
  const flowType = latest?.flow_type != null ? String(latest.flow_type) : null;
  const intentEquivalent =
    flowType === "onboarding_first_connection" || flowType === "first_account";

  const { data: maRows } = await adm
    .from("marketplace_accounts")
    .select("id, status, external_seller_id, seller_company_id, marketplace, created_at")
    .eq("user_id", USER_ID)
    .eq("marketplace", "ml");

  const rows = Array.isArray(maRows) ? maRows : [];
  const activeMa = rows.filter((r) => {
    const s = r.status != null ? String(r.status).trim().toLowerCase() : "";
    return s !== "removed";
  });
  const sellerScoped = rows.filter(
    (r) => String(r.seller_company_id || "").toLowerCase() === SELLER_ID.toLowerCase(),
  );

  let oauthConfig = {};
  try {
    const res = await fetch(`${VERCEL_HOST}/api/ml/oauth-config`, { signal: AbortSignal.timeout(15000) });
    oauthConfig = await res.json();
  } catch (err) {
    oauthConfig = { error: err?.message ?? String(err) };
  }

  const redirectHost = oauthConfig.redirectUri ? new URL(String(oauthConfig.redirectUri)).host : null;

  const { error: flowTypeColErr } = await adm
    .from("oauth_states")
    .select("flow_type")
    .limit(1);
  const flowTypeColumnPresent = !flowTypeColErr || !/column|42703|does not exist/i.test(String(flowTypeColErr.message));

  let idxProbe = null;
  try {
    const idxRes = await adm
      .from("pg_indexes")
      .select("indexname")
      .eq("indexname", "marketplace_accounts_global_active_external_uidx")
      .maybeSingle();
    idxProbe = idxRes.data;
  } catch {
    idxProbe = null;
  }

  const report = {
    generatedAt: now.toISOString(),
    freshDevRef: ref,
    freshDevRefMatch: ref === EXPECTED_REF,
    oauthState: {
      found: Boolean(latest),
      activeNonExpiredCount: activeStates.length,
      statePreview: maskState(latest?.state),
      createdRecently,
      consumed: false,
      expired: latest ? !notExpired : null,
      minutesToExpiry: msToExpiry != null ? Math.round(msToExpiry / 60000) : null,
      sellerCompanyMatch: sellerMatch,
      userMatch,
      flowType,
      intentInitialConfigurationEquivalent: intentEquivalent,
      sellerCompanyIdTrunc: truncateId(latest?.seller_company_id),
      userIdTrunc: truncateId(latest?.user_id),
    },
    marketplaceAccounts: {
      total: rows.length,
      activeCount: activeMa.length,
      sellerScopedCount: sellerScoped.length,
      activeMlLinked: activeMa.length > 0,
      duplicatePreExisting: activeMa.length > 1,
      idsTrunc: activeMa.map((r) => truncateId(r.id)),
    },
    vercelOAuthConfig: {
      supabaseProjectRef: oauthConfig.supabaseProjectRef ?? null,
      expectedSupabaseProjectRef: oauthConfig.expectedSupabaseProjectRef ?? null,
      redirectHost,
      callbackHostCorrect: redirectHost === "suse7-backend-dev.vercel.app",
      envAligned:
        oauthConfig.supabaseProjectRef === EXPECTED_REF &&
        oauthConfig.expectedSupabaseProjectRef === EXPECTED_REF,
    },
    pkce: {
      usedByMlFlow: false,
      note: "ML OAuth usa client_secret no token exchange; sem code_verifier/challenge no código.",
    },
    schema: {
      oauthStatesFlowTypeColumn: flowTypeColumnPresent ? "present" : "missing",
      globalUniqueIndex: idxProbe?.indexname ? "PASS" : "unknown_pg_indexes_not_exposed",
    },
    activeStatesSummary: activeStates.map((r) => ({
      statePreview: maskState(r.state),
      flowType: r.flow_type ?? null,
      minutesToExpiry:
        r.expires_at != null
          ? Math.round((new Date(String(r.expires_at)).getTime() - now.getTime()) / 60000)
          : null,
      sellerMatch:
        r.seller_company_id != null
          ? String(r.seller_company_id).toLowerCase() === SELLER_ID.toLowerCase()
          : null,
    })),
  };

  const outDir = path.resolve(REPO, "../scripts/output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "M6_PRE_AUTHORIZE_OAUTH_SANITY_2026-08-16.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nartifact: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
