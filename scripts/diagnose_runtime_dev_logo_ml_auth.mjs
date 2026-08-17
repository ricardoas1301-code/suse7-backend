#!/usr/bin/env node
/**
 * RCA runtime DEV — logo header + ML auth (sem expor tokens/secrets).
 * Uso (a partir de suse7-backend): node scripts/diagnose_runtime_dev_logo_ml_auth.mjs [--email=...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });

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
  if (!url) return null;
  try {
    const host = new URL(url.replace(/\/+$/, "")).hostname;
    const m = host.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    const s = String(url);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
}

function urlType(url) {
  if (!url) return "absent";
  const s = String(url);
  if (s.includes("/storage/v1/object/public/")) return "supabase_public_storage";
  if (s.includes("/storage/v1/object/sign/")) return "supabase_signed_storage";
  if (s.startsWith("http://") || s.startsWith("https://")) return "absolute_http";
  return "path_or_unknown";
}

async function headImage(url) {
  if (!url) return { skipped: true };
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return {
      status: res.status,
      content_type: res.headers.get("content-type"),
      final_url_host: sanitizeUrl(res.url)?.split("/").slice(0, 3).join("/"),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const emailArg = process.argv.find((a) => a.startsWith("--email="))?.split("=")[1]?.trim();

const feDevLocal = parseDotEnv(path.join(repoRoot, "suse7-frontend", ".env.development.local"));
const feDev = parseDotEnv(path.join(repoRoot, "suse7-frontend", ".env.development"));
const fePlainLocal = parseDotEnv(path.join(repoRoot, "suse7-frontend", ".env.local"));

const feEffectiveUrl = feDevLocal.VITE_SUPABASE_URL || feDev.VITE_SUPABASE_URL || fePlainLocal.VITE_SUPABASE_URL;
const feEffectiveApi = feDevLocal.VITE_API_BASE_URL || feDev.VITE_API_BASE_URL || fePlainLocal.VITE_API_BASE_URL;
const beUrl = process.env.SUPABASE_URL;
const beServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const report = {
  environment: {
    frontend_effective_supabase_ref: projectRefFromUrl(feEffectiveUrl),
    frontend_effective_api_base: feEffectiveApi || null,
    backend_supabase_ref: projectRefFromUrl(beUrl),
    environments_aligned:
      projectRefFromUrl(feEffectiveUrl) && projectRefFromUrl(beUrl)
        ? projectRefFromUrl(feEffectiveUrl) === projectRefFromUrl(beUrl)
        : null,
    frontend_dev_local_ref: projectRefFromUrl(feDevLocal.VITE_SUPABASE_URL),
    frontend_development_ref: projectRefFromUrl(feDev.VITE_SUPABASE_URL),
    ml_redirect_uri_host: (() => {
      try {
        return process.env.ML_REDIRECT_URI ? new URL(process.env.ML_REDIRECT_URI).host : null;
      } catch {
        return null;
      }
    })(),
  },
};

if (!beUrl || !beServiceKey) {
  console.error(JSON.stringify({ error: "backend_supabase_env_missing", report }, null, 2));
  process.exit(1);
}

const supabase = createClient(beUrl, beServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** @type {string | null} */
let targetUserId = null;
/** @type {string | null} */
let targetEmail = emailArg || null;

if (targetEmail) {
  const { data: users } = await supabase.auth.admin.listUsers({ perPage: 200 });
  const match = users?.users?.find((u) => String(u.email || "").toLowerCase() === targetEmail.toLowerCase());
  targetUserId = match?.id ?? null;
}

if (!targetUserId) {
  const { data: mlAccounts } = await supabase
    .from("marketplace_accounts")
    .select("user_id, id, status, marketplace, external_seller_id, created_at")
    .eq("marketplace", "mercado_livre")
    .neq("status", "removed")
    .order("created_at", { ascending: false })
    .limit(20);

  const active = (mlAccounts ?? []).filter((a) => String(a.status).toLowerCase() === "active");
  targetUserId = active[0]?.user_id ?? mlAccounts?.[0]?.user_id ?? null;
}

if (!targetUserId) {
  console.error(JSON.stringify({ error: "no_target_user", report }, null, 2));
  process.exit(1);
}

if (!targetEmail) {
  const { data: userData } = await supabase.auth.admin.getUserById(targetUserId);
  targetEmail = userData?.user?.email ?? null;
}

const { resolveMlInitialSyncOperationalPhase } = await import(
  "../src/domain/dashboard/resolveMlInitialSyncOperationalPhase.js"
);
const { fetchMlTokenProbeForMlSeller, buildMlConnectionUiPack } = await import(
  "../src/services/marketplace/marketplaceAccountConnectionHealth.js"
);
const { buildMarketplaceIntegrationPresentation } = await import(
  "../src/services/marketplace/marketplaceIntegrationPresentation.js"
);
const { carregarLogoUrlEmpresaPrincipal } = await import("../src/domain/seller/carregarLogoUrlEmpresaPrincipal.js");

const { data: companies } = await supabase
  .from("seller_companies")
  .select("id, user_id, trade_name, company_name, document_cnpj, logo_url, is_primary, active, created_at")
  .eq("user_id", targetUserId);

const primary =
  (companies ?? []).find((c) => c.is_primary === true) ??
  (companies ?? []).find((c) => c.active !== false) ??
  (companies ?? [])[0] ??
  null;

const loadedLogoUrl = await carregarLogoUrlEmpresaPrincipal(supabase, targetUserId);

const { data: profile } = await supabase
  .from("profiles")
  .select("nome_loja, photo_url, account_alias")
  .eq("id", targetUserId)
  .maybeSingle();

const logoUrlRaw = primary?.logo_url ?? primary?.avatar_url ?? null;
const logoHead = await headImage(logoUrlRaw ? String(logoUrlRaw) : null);

const { data: mlAccountsUser } = await supabase
  .from("marketplace_accounts")
  .select("id, marketplace, status, external_seller_id, seller_company_id, created_at, updated_at")
  .eq("user_id", targetUserId)
  .eq("marketplace", "mercado_livre")
  .neq("status", "removed")
  .order("created_at", { ascending: false });

const primaryMlAccount = mlAccountsUser?.[0] ?? null;

const { data: mlTokens, error: mlTokErr } = await supabase
  .from("ml_tokens")
  .select("id, user_id, marketplace, ml_user_id, expires_at, updated_at")
  .eq("user_id", targetUserId)
  .eq("marketplace", "mercado_livre");

const tokenRows = Array.isArray(mlTokens) ? mlTokens : [];

let accessPresent = false;
let refreshPresent = false;
if (!mlTokErr && tokenRows.length) {
  const { data: secretRow } = await supabase
    .from("ml_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("id", tokenRows[0].id)
    .maybeSingle();
  accessPresent = secretRow?.access_token != null && String(secretRow.access_token).trim() !== "";
  refreshPresent = secretRow?.refresh_token != null && String(secretRow.refresh_token).trim() !== "";
}

const ext = primaryMlAccount?.external_seller_id != null ? String(primaryMlAccount.external_seller_id).trim() : "";
const mac = primaryMlAccount?.id != null ? String(primaryMlAccount.id).trim() : "";

let tokenByMac = null;
if (mac) {
  const q = await supabase
    .from("ml_tokens")
    .select("id, ml_user_id, expires_at")
    .eq("user_id", targetUserId)
    .eq("marketplace", "mercado_livre")
    .eq("ml_user_id", ext)
    .maybeSingle();
  tokenByMac = q.data;
  if (q.error && String(q.error.message ?? "").includes("marketplace_account_id")) {
    tokenByMac = tokenByMac ?? null;
  }
}

let tokenByMlUser = null;
if (ext) {
  const q = await supabase
    .from("ml_tokens")
    .select("id, ml_user_id, marketplace_account_id, expires_at")
    .eq("user_id", targetUserId)
    .eq("marketplace", "mercado_livre")
    .eq("ml_user_id", ext)
    .maybeSingle();
  tokenByMlUser = q.data;
}

const expiresAt = tokenByMac?.expires_at ?? tokenByMlUser?.expires_at ?? tokenRows[0]?.expires_at ?? null;
const expiresMs = expiresAt ? Date.parse(String(expiresAt)) : NaN;
const tokenExpired = Number.isFinite(expiresMs) ? Date.now() >= expiresMs - 60000 : null;

const mlSyncPhase = await resolveMlInitialSyncOperationalPhase(supabase, targetUserId);
const tokenProbe = await fetchMlTokenProbeForMlSeller(supabase, targetUserId, "mercado_livre", ext, mac);
const connectionPack = buildMlConnectionUiPack(
  { status: primaryMlAccount?.status ?? "unknown" },
  tokenProbe,
  false,
);
const integrationPresentation = buildMarketplaceIntegrationPresentation({
  connectionPack,
  mlInitialSyncPhase: mlSyncPhase.phase,
  authResolved: true,
});

report.seller = {
  user_id: targetUserId,
  email: targetEmail,
};

report.logo = {
  seller_companies_count: (companies ?? []).length,
  primary_company_id: primary?.id ?? null,
  resolver_primary_company_id: primary?.id ?? null,
  primary_is_primary_flag: primary?.is_primary ?? null,
  trade_name: primary?.trade_name ?? primary?.company_name ?? null,
  cnpj_last4: primary?.document_cnpj ? String(primary.document_cnpj).replace(/\D/g, "").slice(-4) : null,
  logo_url_present: Boolean(primary?.logo_url && String(primary.logo_url).trim()),
  logo_url_type: urlType(primary?.logo_url),
  logo_url_sanitized: sanitizeUrl(primary?.logo_url),
  avatar_url_present: false,
  profile_photo_url_present: Boolean(profile?.photo_url && String(profile.photo_url).trim()),
  profile_photo_url_type: urlType(profile?.photo_url),
  profile_summary_logo_url_present: Boolean(loadedLogoUrl),
  profile_summary_logo_url_sanitized: sanitizeUrl(loadedLogoUrl),
  resolver_would_return_logo_url: Boolean(loadedLogoUrl),
  image_head: logoHead,
};

report.mercado_livre = {
  marketplace_account_id: mac || null,
  status: primaryMlAccount?.status ?? null,
  external_seller_id_present: Boolean(ext),
  external_seller_id_suffix: ext ? ext.slice(-4) : null,
  seller_company_id: primaryMlAccount?.seller_company_id ?? null,
  ml_tokens_row_count: tokenRows.length,
  ml_tokens_query_error: mlTokErr ? String(mlTokErr.message ?? mlTokErr.code) : null,
  access_token_present: accessPresent,
  refresh_token_present: refreshPresent,
  token_by_marketplace_account_id: Boolean(tokenByMac && ext && String(tokenByMac.ml_user_id) === ext),
  token_by_ml_user_id: Boolean(tokenByMlUser),
  marketplace_account_id_match: tokenByMac && ext ? String(tokenByMac.ml_user_id) === ext : null,
  ml_user_id_match: tokenByMlUser ? String(tokenByMlUser.ml_user_id) === ext : null,
  expires_at_present: Boolean(expiresAt),
  token_expired: tokenExpired,
  token_probe: {
    present: tokenProbe.present,
    has_refresh: tokenProbe.has_refresh,
    token_account_mismatch: Boolean(tokenProbe.token_account_mismatch),
    resolved_via: tokenProbe.resolved_via ?? null,
  },
  connection_health: connectionPack.connection_health,
  connection_badge_label: connectionPack.connection_badge_label,
  integration_badge_label: integrationPresentation.integration_badge_label,
  show_reconnect_cta: integrationPresentation.show_reconnect_cta,
  ml_initial_sync_phase: mlSyncPhase.phase,
};

console.log(JSON.stringify(report, null, 2));
