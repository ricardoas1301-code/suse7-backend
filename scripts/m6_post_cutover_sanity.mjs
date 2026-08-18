#!/usr/bin/env node
/** Pós-cutover sanity — sem secrets */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const HOST = "https://suse7-backend-dev.vercel.app";
const NEW_REF = "alkelcaoexxbamqddaqv";
const SELLER_ID = "5660a0d1-6105-4aaa-9835-6c8d9d54199c";
const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";

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
    out[trimmed.slice(0, eq).trim()] = val.trim();
  }
  return out;
}

const env = { ...parseDotEnv(".env"), ...parseDotEnv(".env.local") };

const oauthRes = await fetch(`${HOST}/api/ml/oauth-config`);
const oauth = await oauthRes.json();

const adm = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: seller } = await adm
  .from("seller_companies")
  .select("id, user_id, active")
  .eq("id", SELLER_ID)
  .maybeSingle();
const { data: user } = await adm.from("profiles").select("id").eq("id", USER_ID).maybeSingle();

const qs = new URLSearchParams({ user_id: USER_ID, seller_company_id: SELLER_ID, intent: "initial_configuration" });
const connectRes = await fetch(`${HOST}/api/ml/connect?${qs}`, { redirect: "manual" });
const location = connectRes.headers.get("location") || "";
let connectBody = null;
if (connectRes.status >= 400) connectBody = await connectRes.json().catch(() => ({}));

const { error: stateErr } = await adm.from("oauth_states").select("state").limit(1);

const report = {
  environmentGuard: {
    actual: oauth.supabaseProjectRef,
    expected: oauth.expectedSupabaseProjectRef,
    match: oauth.supabaseProjectRef === NEW_REF && oauth.expectedSupabaseProjectRef === NEW_REF,
  },
  seller: {
    exists: Boolean(seller?.id),
    active: seller?.active ?? null,
    ownership: seller?.user_id != null && String(seller.user_id).toLowerCase() === USER_ID.toLowerCase(),
  },
  user: { exists: Boolean(user?.id) },
  oauthCallback: {
    redirectHost: oauth.redirectUri ? new URL(oauth.redirectUri).host : null,
    sameEnvironment: oauth.supabaseProjectRef === NEW_REF,
  },
  connectSanity: {
    status: connectRes.status,
    sellerBlocked: connectBody?.code === "seller_company_not_owned_by_user",
    isMlAuthRedirect: /auth\.mercadolivre\.com\.br/i.test(location),
    locationHost: location ? new URL(location).hostname : null,
    errorCode: connectBody?.code ?? null,
  },
  oauthStatesTable: stateErr ? `ERR:${stateErr.message.slice(0, 60)}` : "OK",
  consumersQuick: {},
};

try {
  const wh = await fetch(`${HOST}/api/jobs/ml-webhook-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Job-Secret": "invalid-probe" },
    body: '{"limit":1}',
  });
  report.consumersQuick.mlWebhookJob = { status: wh.status, note: wh.status === 401 || wh.status === 403 ? "auth_gate_ok" : "check" };
} catch (e) {
  report.consumersQuick.mlWebhookJob = { error: e.message };
}

console.log(JSON.stringify(report, null, 2));
if (!report.environmentGuard.match) process.exit(2);
if (!report.seller.exists || !report.seller.ownership) process.exit(3);
if (report.connectSanity.sellerBlocked) process.exit(4);
