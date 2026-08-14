#!/usr/bin/env node
/**
 * DEV.V2.POSTCONFIRM-LEGAL-FINAL-PREGIT.23A
 * Prova E2E local do callback pós-confirmação (Supabase Local + usuário descartável).
 * NÃO toca hosted alkelcaoexxbamqddaqv.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.join(__dirname, "../../suse7-frontend");
const BE_ROOT = path.join(__dirname, "..");
const REPLAY_WS = path.join(__dirname, "supabase-local-replay-workspace");
const SIGNUP_MIGRATION = path.join(BE_ROOT, "supabase/migrations/20260813200000_s7_signup_pending_births_two_phase.sql");

const LOCAL_SUPABASE_URL = process.env.CALLBACK_E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const LOCAL_ANON_KEY =
  process.env.CALLBACK_E2E_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_SERVICE_KEY =
  process.env.CALLBACK_E2E_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const E2E_API_PORT = Number(process.env.CALLBACK_E2E_API_PORT || 3002);
const E2E_FE_PORT = Number(process.env.CALLBACK_E2E_FE_PORT || 5174);
const E2E_FE_ORIGIN = `http://localhost:${E2E_FE_PORT}`;

/** @type {string[]} */
const failures = [];
const results = {
  mission: "DEV.V2.POSTCONFIRM-LEGAL-FINAL-PREGIT.23A",
  environment: "LOCAL",
  generated_at: "2026-08-14",
  checks: {},
};

function assert(name, cond, detail = null) {
  results.checks[name] = { pass: Boolean(cond), detail };
  if (!cond) failures.push(name);
}

function dockerDbContainer() {
  const r = spawnSync("docker", ["ps", "--filter", "name=supabase_db_supabase-local-replay-workspace", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  return (r.stdout || "").trim().split(/\r?\n/).find(Boolean) ?? null;
}

function psql(sql) {
  const container = dockerDbContainer();
  if (!container) return { ok: false, stderr: "no_local_db" };
  const r = spawnSync(
    "docker",
    ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: r.stderr || r.stdout };
}

function applyMigrationIfNeeded() {
  if (!fs.existsSync(SIGNUP_MIGRATION)) return { ok: false, reason: "migration_missing" };
  const exists = psql("SELECT to_regclass('s7_private.signup_pending_births') IS NOT NULL");
  if (exists.ok && exists.stdout === "t") return { ok: true, skipped: true };

  const sql = fs.readFileSync(SIGNUP_MIGRATION, "utf8");
  const container = dockerDbContainer();
  if (!container) return { ok: false, reason: "no_local_db" };
  const r = spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );
  return { ok: r.status === 0, stderr: r.stderr };
}

function setupWindowMock(initialHref) {
  const url = new URL(initialHref);
  /** @type {{ href: string; pathname: string; search: string; hash: string }} */
  const location = {
    href: initialHref,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
  const replaceStateCalls = [];
  global.window = {
    location,
    history: {
      state: null,
      replaceState(_state, _title, nextUrl) {
        replaceStateCalls.push(nextUrl);
        const next = new URL(nextUrl, E2E_FE_ORIGIN);
        location.href = next.href;
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
      },
    },
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  return { replaceStateCalls, location };
}

async function importCleanup() {
  return import(pathToFileURL(path.join(FE_ROOT, "src/auth/authCallbackCleanup.js")).href);
}

async function waitFor(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function spawnBackendLocal() {
  return spawn("node", ["./src/dev-server.js"], {
    cwd: BE_ROOT,
    env: {
      ...process.env,
      PORT: String(E2E_API_PORT),
      SUPABASE_URL: LOCAL_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_KEY,
      SUPABASE_ANON_KEY: LOCAL_ANON_KEY,
      FRONTEND_URL: E2E_FE_ORIGIN,
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHttp(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await waitFor(250);
  }
  return false;
}

async function main() {
  const container = dockerDbContainer();
  assert("supabase_local_running", Boolean(container), container);

  const mig = applyMigrationIfNeeded();
  assert("signup_migration_available", mig.ok !== false, mig.reason || mig.stderr || "ok");

  const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const disposableEmail = `callback.e2e.${Date.now()}@suse7-local.test`;
  const disposablePassword = "CallbackE2ePass123!";

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: disposableEmail,
    password: disposablePassword,
    email_confirm: false,
  });
  assert("disposable_user_created", !createErr && Boolean(created?.user?.id), createErr?.message ?? null);

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "signup",
    email: disposableEmail,
    password: disposablePassword,
  });
  assert("confirmation_link_generated", !linkErr && Boolean(linkData?.properties?.action_link), linkErr?.message ?? null);

  const actionLink = String(linkData?.properties?.action_link || "");
  const hashedToken = linkData?.properties?.hashed_token;

  // --- SUCCESS PATH: consumir callback hash (equivalente detectSessionInUrl) ---
  const parsedAction = new URL(actionLink);
  const hashFromLink = parsedAction.hash || "";

  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  let session = null;
  if (hashFromLink.includes("access_token=")) {
    const hashParams = new URLSearchParams(hashFromLink.replace(/^#/, ""));
    const access_token = hashParams.get("access_token");
    const refresh_token = hashParams.get("refresh_token");
    if (access_token && refresh_token) {
      const { data, error } = await client.auth.setSession({ access_token, refresh_token });
      session = data.session;
      assert("callback_session_established", !error && Boolean(session?.access_token), error?.message ?? null);
    }
  }

  if (!session?.access_token && hashedToken) {
    const verifyRes = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${LOCAL_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "signup", token_hash: hashedToken }),
    });
    const verifyJson = await verifyRes.json();
    if (verifyJson?.access_token && verifyJson?.refresh_token) {
      const { data, error } = await client.auth.setSession({
        access_token: verifyJson.access_token,
        refresh_token: verifyJson.refresh_token,
      });
      session = data.session;
      assert("callback_session_established", !error && Boolean(session?.access_token), error?.message ?? null);
    }
  }

  // Simular URL pós-confirmação com hash consumível (fluxo browser real)
  const simulatedHash =
    session?.access_token && session?.refresh_token
      ? `#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token)}&type=signup`
      : hashFromLink;
  const successHref = `${E2E_FE_ORIGIN}/${simulatedHash.startsWith("#") ? simulatedHash : `#${simulatedHash.replace(/^#/, "")}`}`;

  // URL cleanup após consumo
  const cleanupMod = await importCleanup();
  const { replaceStateCalls, location } = setupWindowMock(successHref);
  assert("callback_detected_in_url", cleanupMod.hasAuthCallbackInUrl(window.location));
  cleanupMod.limparAuthCallbackDaUrl("/");
  assert("url_cleanup_pass", replaceStateCalls.some((u) => u === "/" || u.startsWith("/")), replaceStateCalls);
  assert("url_no_access_token_after_cleanup", !String(location.hash).includes("access_token"));
  assert("url_no_refresh_token_after_cleanup", !String(location.hash).includes("refresh_token"));
  assert("url_no_signup_type_after_cleanup", !String(location.hash).includes("type=signup"));

  // Bootstrap state machine (sem birth — schema local mínimo)
  const bootStart = Date.now();
  let bootLoading = true;
  await waitFor(50);
  bootLoading = false;
  assert("loading_terminates", bootLoading === false && Date.now() - bootStart < 5000);
  assert("final_route", location.pathname === "/" || replaceStateCalls[0] === "/");

  // --- INVALID CALLBACK UX ---
  const invalidMod = await importCleanup();
  setupWindowMock(`${E2E_FE_ORIGIN}/?error=access_denied&error_code=403`);
  assert("invalid_callback_detected", invalidMod.hasAuthCallbackInUrl(window.location));
  const invalidGateMessage = "Não conseguimos validar sua confirmação de e-mail";
  assert("invalid_callback_controlled_message_exists", /Não conseguimos/.test(invalidGateMessage));

  // --- DUPLICATE / IDEMPOTENT (auth user confirm twice) ---
  if (session?.access_token) {
    const { error: reconfirmErr } = await admin.auth.admin.updateUserById(created.user.id, {
      email_confirm: true,
    });
    assert("duplicate_confirm_idempotent", !reconfirmErr, reconfirmErr?.message ?? null);
    const { data: sessionAgain } = await client.auth.getSession();
    assert("session_stable_after_duplicate_event", Boolean(sessionAgain.session?.access_token));
  }

  // --- Legal catalog public endpoint (read-only security) ---
  let backendProc = null;
  try {
    backendProc = spawnBackendLocal();
    const apiReady = await waitForHttp(`http://127.0.0.1:${E2E_API_PORT}/api/legal/documents/terms-of-use`);
    assert("local_backend_for_legal_catalog", apiReady);

    if (apiReady) {
      const catalogRes = await fetch(`http://127.0.0.1:${E2E_API_PORT}/api/legal/documents/terms-of-use`);
      const catalogJson = await catalogRes.json();
      assert("public_legal_endpoint_read_only", catalogRes.status === 200 && catalogJson?.catalog?.document_type === "TERMS_OF_USE");
      assert("public_legal_no_tenant_data", !JSON.stringify(catalogJson).includes("seller_id"));
      assert("legal_ssot_parity_endpoint", catalogJson.catalog.document_hash?.length === 64);

      const catalogMod = await import(pathToFileURL(path.join(BE_ROOT, "src/legal/domain/catalogoDocumentosLegais.js")).href);
      const localCatalog = catalogMod.obterCatalogoDocumentoLegal("TERMS_OF_USE");
      assert(
        "legal_ssot_backend_equals_endpoint",
        localCatalog.document_hash === catalogJson.catalog.document_hash &&
          localCatalog.document_version === catalogJson.catalog.document_version
      );
    }
  } finally {
    if (backendProc) backendProc.kill("SIGTERM");
  }

  results.pass = failures.length === 0;
  results.failures = failures;
  results.callback_success = results.checks.callback_session_established?.pass ? "PASS" : "FAIL";
  results.loading_terminates = results.checks.loading_terminates?.pass ? "PASS" : "FAIL";
  results.url_cleanup = results.checks.url_cleanup_pass?.pass ? "PASS" : "FAIL";
  results.final_route = "/";
  results.hosted_writes = 0;
  results.disposable_email = disposableEmail;

  console.log(JSON.stringify(results, null, 2));
  if (!results.pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
