#!/usr/bin/env node
/**
 * Fase B — Cutover Vercel suse7-backend-dev → Fresh DEV alkelcaoexxbamqddaqv
 * Não imprime secrets. Não toca projeto PROD.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(BACKEND_ROOT, "..");
const ALLOWED_PROJECT = "suse7-backend-dev";
const ALLOWED_PROJECT_ID = "prj_TvAjlZFVkLOrgxW7bgGD5VIX7LK3";
const NEW_REF = "alkelcaoexxbamqddaqv";
const OLD_REF = "ujznkyvgqhxagemdgmor";
const HOSTNAME = "suse7-backend-dev.vercel.app";
const SELLER_ID = "5660a0d1-6105-4aaa-9835-6c8d9d54199c";
const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const ENV_SCOPES = ["production", "development"];

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

function vercel(cmdArgs) {
  const vercelCmd = process.platform === "win32" ? "vercel.cmd" : "vercel";
  return execFileSync(vercelCmd, cmdArgs, {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

function assertProject() {
  const pj = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, ".vercel", "project.json"), "utf8"));
  if (pj.projectName !== ALLOWED_PROJECT || pj.projectId !== ALLOWED_PROJECT_ID) {
    throw new Error(`HARD STOP: projeto Vercel inesperado ${pj.projectName} / ${pj.projectId}`);
  }
  return pj;
}

function upsertVercelEnv(name, value, scope) {
  try {
    vercel(["env", "rm", name, scope, "-y"]);
  } catch {
    /* ok if missing */
  }
  vercel(["env", "add", name, scope, "--value", value, "--sensitive", "-y", "--force"]);
}

async function probeSeller(env) {
  const adm = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: seller } = await adm
    .from("seller_companies")
    .select("id, user_id, active")
    .eq("id", SELLER_ID)
    .maybeSingle();
  const { data: user } = await adm.from("profiles").select("id").eq("id", USER_ID).maybeSingle();
  return {
    sellerExists: Boolean(seller?.id),
    sellerActive: seller?.active ?? null,
    userExists: Boolean(user?.id),
    ownership:
      seller?.user_id != null && String(seller.user_id).toLowerCase() === USER_ID.toLowerCase(),
  };
}

async function fetchOAuthProbe(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/ml/oauth-config`, {
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status,
    supabaseProjectRef: body?.supabaseProjectRef ?? null,
    expectedSupabaseProjectRef: body?.expectedSupabaseProjectRef ?? null,
    redirectUri: body?.redirectUri ?? null,
    ok: body?.ok ?? null,
  };
}

async function simulateConnectOwnership(baseUrl) {
  const qs = new URLSearchParams({
    user_id: USER_ID,
    seller_company_id: SELLER_ID,
    intent: "initial_configuration",
  });
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/ml/connect?${qs}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const location = res.headers.get("location") || res.headers.get("Location") || "";
  let body = null;
  if (res.status >= 400) {
    body = await res.json().catch(() => ({}));
  }
  return {
    status: res.status,
    locationHost: location ? new URL(location).hostname : null,
    isMlAuth: /auth\.mercadolivre\.com\.br/i.test(location),
    errorCode: body?.code ?? null,
    reason: body?.reason ?? null,
    sellerBlocked: body?.code === "seller_company_not_owned_by_user",
  };
}

async function main() {
  const pj = assertProject();
  const localEnv = {
    ...parseDotEnv(path.join(BACKEND_ROOT, ".env")),
    ...parseDotEnv(path.join(BACKEND_ROOT, ".env.local")),
  };
  const localRef = projectRefFromUrl(localEnv.SUPABASE_URL);
  if (localRef !== NEW_REF) throw new Error(`Fresh DEV local env ref mismatch: ${localRef}`);
  if (!localEnv.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.local");

  const preCutover = {
    consumers: {
      billingCronDev: "GitHub billing-maintenance-cron-dev — 06:00 UTC",
      mlWebhookCronDev: "GitHub ml-webhook-events-cron-dev — */1 min",
      mlWebhookIngress: "POST /api/ml/webhook",
      mlOAuthCallback: `https://${HOSTNAME}/api/ml/callback`,
      asaasSandbox: "ASAAS_ENV sandbox no backend DEV",
    },
    cronPaused: false,
    cronPauseReason:
      "Crons GitHub não disparam no instante do redeploy; Fresh DEV sem contas ML legadas ativas no ujzn",
  };

  /** @type {Record<string, unknown>} */
  const report = {
    mission: "M6_VERCEL_DEV_FRESH_CUTOVER",
    timestamp: new Date().toISOString(),
    vercelProject: {
      name: pj.projectName,
      projectId: pj.projectId,
      hostname: HOSTNAME,
      environmentScopesUpdated: ENV_SCOPES,
      prodSuse7BackendTouched: false,
    },
    preCutover,
    variablesUpdated: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "S7_EXPECTED_SUPABASE_PROJECT_REF"],
    projectRefChange: { from: OLD_REF, to: NEW_REF },
  };

  for (const scope of ENV_SCOPES) {
    upsertVercelEnv("SUPABASE_URL", localEnv.SUPABASE_URL, scope);
    upsertVercelEnv("SUPABASE_SERVICE_ROLE_KEY", localEnv.SUPABASE_SERVICE_ROLE_KEY, scope);
    upsertVercelEnv("S7_EXPECTED_SUPABASE_PROJECT_REF", NEW_REF, scope);
  }

  const deployOut = vercel(["deploy", "--prod", "--yes", "--no-wait"]);
  const deployUrlMatch = deployOut.match(/https:\/\/[^\s]+vercel\.app[^\s]*/);
  report.redeploy = {
    triggered: true,
    deployUrlHint: deployUrlMatch ? deployUrlMatch[0].replace(/\/+$/, "") : null,
    timestamp: new Date().toISOString(),
  };

  await new Promise((r) => setTimeout(r, 60000));

  let probe = await fetchOAuthProbe(`https://${HOSTNAME}`);
  for (let i = 0; i < 10 && probe.supabaseProjectRef !== NEW_REF; i += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    probe = await fetchOAuthProbe(`https://${HOSTNAME}`);
  }

  const sellerProbe = await probeSeller(localEnv);
  const connectProbe = await simulateConnectOwnership(`https://${HOSTNAME}`);

  report.environmentGuard = {
    actualProjectRef: probe.supabaseProjectRef,
    expectedProjectRef: probe.expectedSupabaseProjectRef,
    match: probe.supabaseProjectRef === NEW_REF && probe.expectedSupabaseProjectRef === NEW_REF,
  };
  report.sellerUserOwnership = sellerProbe;
  report.oauthStartCallback = {
    startProjectRef: probe.supabaseProjectRef,
    callbackHost: probe.redirectUri ? new URL(probe.redirectUri).host : null,
    callbackSameEnvironment: probe.supabaseProjectRef === NEW_REF,
  };
  report.connectSanity = connectProbe;

  const outPath = path.join(
    REPO,
    "scripts",
    "output",
    `M6_VERCEL_DEV_FRESH_CUTOVER_${new Date().toISOString().slice(0, 10)}.json`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[cutover] artifact: ${outPath}`);

  if (!report.environmentGuard.match) process.exit(2);
  if (!sellerProbe.sellerExists || !sellerProbe.userExists || !sellerProbe.ownership) process.exit(3);
  if (connectProbe.sellerBlocked) process.exit(4);
}

main().catch((err) => {
  console.error("[cutover] FAIL", err?.message ?? err);
  if (err?.stderr) console.error(String(err.stderr).slice(0, 500));
  process.exit(1);
});
