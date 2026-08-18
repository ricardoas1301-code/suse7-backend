#!/usr/bin/env node
/**
 * E2E HTTP — POST /api/legal/document-acceptances (runtime local :3001).
 * Cria usuário efêmero, persiste aceite, valida banco e limpa.
 *
 * Uso:
 *   node scripts/test_legal_document_acceptances_http_e2e_dev.mjs
 *   node scripts/test_legal_document_acceptances_http_e2e_dev.mjs --api-base http://localhost:3001
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  TERMOS_USO_HASH_CONTEUDO,
  TERMOS_USO_TIPO_DOCUMENTO,
  TERMOS_USO_VERSAO_ID,
} from "../src/legal/domain/documentosLegaisCanonicos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
dotenv.config({ path: path.join(root, ".env.local"), override: true });

const args = process.argv.slice(2);
const apiBaseArgIdx = args.indexOf("--api-base");
const API_BASE = (
  apiBaseArgIdx >= 0 && args[apiBaseArgIdx + 1] ? args[apiBaseArgIdx + 1] : "http://localhost:3001"
)
  .replace(/\/+$/, "");

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || SERVICE_KEY;

/** @type {string[]} */
const failures = [];

function assert(name, cond, detail = "") {
  if (!cond) failures.push(detail ? `${name}: ${detail}` : name);
}

const endpoint = `${API_BASE}/api/legal/document-acceptances`;

async function http(method, body = null, token = null) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(endpoint, {
    method,
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const getRes = await http("GET");
assert("GET not 404", getRes.status !== 404, `status=${getRes.status}`);
assert("GET is 405", getRes.status === 405, `status=${getRes.status}`);

const postNoAuth = await http("POST", { document_type: TERMOS_USO_TIPO_DOCUMENTO });
assert("POST no auth not 404", postNoAuth.status !== 404, `status=${postNoAuth.status}`);
assert(
  "POST no auth gated",
  postNoAuth.status === 401 || postNoAuth.status === 403 || postNoAuth.status === 503,
  `status=${postNoAuth.status}`,
);

const postBadHash = await http(
  "POST",
  {
    document_type: TERMOS_USO_TIPO_DOCUMENTO,
    document_version: TERMOS_USO_VERSAO_ID,
    document_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    scrolled_to_end: true,
  },
  "fake-token",
);
assert("POST bad token not 404", postBadHash.status !== 404, `status=${postBadHash.status}`);

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.warn("[legal-e2e] SKIP authenticated/db checks — missing Supabase env");
} else {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const email = `legal-e2e-${Date.now()}@suse7-test.local`;
  const password = `E2e_${Date.now()}_Aa1!`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert("ephemeral user created", !createErr && created?.user?.id, createErr?.message ?? "");

  let userId = created?.user?.id ?? null;
  let accessToken = null;

  if (userId) {
    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
    assert("ephemeral user sign-in", !signInErr && signIn.session?.access_token, signInErr?.message ?? "");
    accessToken = signIn.session?.access_token ?? null;
  }

  if (accessToken && userId) {
    const postNoScroll = await http(
      "POST",
      {
        document_type: TERMOS_USO_TIPO_DOCUMENTO,
        document_version: TERMOS_USO_VERSAO_ID,
        document_hash: TERMOS_USO_HASH_CONTEUDO,
        scrolled_to_end: false,
      },
      accessToken,
    );
    assert("POST scrolled_to_end=false blocked", postNoScroll.status === 400, `status=${postNoScroll.status}`);

    const postBadVersion = await http(
      "POST",
      {
        document_type: TERMOS_USO_TIPO_DOCUMENTO,
        document_version: "invalid-version",
        document_hash: TERMOS_USO_HASH_CONTEUDO,
        scrolled_to_end: true,
      },
      accessToken,
    );
    assert("POST bad version blocked", postBadVersion.status === 409, `status=${postBadVersion.status}`);

    const postBadDoc = await http(
      "POST",
      {
        document_type: "UNKNOWN_DOC",
        document_version: TERMOS_USO_VERSAO_ID,
        document_hash: TERMOS_USO_HASH_CONTEUDO,
        scrolled_to_end: true,
      },
      accessToken,
    );
    assert("POST unknown doc blocked", postBadDoc.status === 409, `status=${postBadDoc.status}`);

    const acceptedAt = new Date().toISOString();
    const postOk = await http(
      "POST",
      {
        document_type: TERMOS_USO_TIPO_DOCUMENTO,
        document_version: TERMOS_USO_VERSAO_ID,
        document_hash: TERMOS_USO_HASH_CONTEUDO,
        accepted_at: acceptedAt,
        source: "SIGNUP_E2E_TEST",
        scrolled_to_end: true,
      },
      accessToken,
    );
    assert("POST valid not 404", postOk.status !== 404, `status=${postOk.status}`);
    assert("POST valid success", postOk.status >= 200 && postOk.status < 300, `status=${postOk.status}`);

    const { data: rows, error: rowErr } = await admin
      .from("legal_document_acceptances")
      .select("id,user_id,document_type,document_version,document_hash,accepted_at,source,scrolled_to_end")
      .eq("user_id", userId)
      .eq("document_type", TERMOS_USO_TIPO_DOCUMENTO)
      .order("accepted_at", { ascending: false })
      .limit(1);

    assert("db row loaded", !rowErr && Array.isArray(rows) && rows.length === 1, rowErr?.message ?? "");
    const row = rows?.[0];
    if (row) {
      assert("db document_version", row.document_version === TERMOS_USO_VERSAO_ID);
      assert("db document_hash", row.document_hash === TERMOS_USO_HASH_CONTEUDO);
      assert("db scrolled_to_end", row.scrolled_to_end === true);
      assert("db source", row.source === "SIGNUP_E2E_TEST");
    }

    await admin.from("legal_document_acceptances").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId);
  }
}

if (failures.length) {
  console.error("FAIL test_legal_document_acceptances_http_e2e_dev", failures);
  process.exit(1);
}

console.log("OK test_legal_document_acceptances_http_e2e_dev", {
  apiBase: API_BASE,
  getStatus: getRes.status,
  postNoAuthStatus: postNoAuth.status,
});
