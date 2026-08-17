#!/usr/bin/env node
/**
 * READ ONLY — projeção Fresh DEV V2 sem PII no stdout
 * CARD.CONFIGURATION.ONBOARDING.01B
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { carregarContextoConfiguracaoInicial } from "../src/onboarding/services/carregarContextoConfiguracaoInicial.js";
import { resolveConfigurationSnapshot } from "../src/onboarding/domain/resolverSnapshotConfiguracaoInicial.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const env = {
  ...parseDotEnv(path.join(root, ".env")),
  ...parseDotEnv(path.join(root, ".env.local")),
};

const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const projectRef = env.SUPABASE_URL?.match(/https:\/\/([^.]+)/)?.[1] ?? "unknown";
const userId = process.env.ONBOARDING_READONLY_USER_ID?.trim();

if (!url || !key) {
  console.error(JSON.stringify({ ok: false, code: "MISSING_SUPABASE_ENV" }));
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function resolveUserId() {
  if (userId) return userId;

  const { data: companies, error } = await supabase
    .from("seller_companies")
    .select("user_id, is_primary, default_tax_rate, operational_cost_rate")
    .eq("is_primary", true)
    .is("default_tax_rate", null)
    .is("operational_cost_rate", null)
    .limit(5);

  if (error) throw error;
  if (!companies?.length) return null;

  for (const row of companies) {
    const ctx = await carregarContextoConfiguracaoInicial(supabase, row.user_id);
    const snap = resolveConfigurationSnapshot({
      profile: ctx.profile,
      companies: ctx.companies ?? [],
      legalAcceptance: ctx.legalAcceptance,
    });
    if (snap.configuration.completed === 2 && snap.configuration.percent === 33) {
      return row.user_id;
    }
  }
  return companies[0]?.user_id ?? null;
}

try {
  const uid = await resolveUserId();
  if (!uid) {
    console.log(JSON.stringify({ ok: false, code: "SELLER_NOT_RESOLVED", project_ref: projectRef }, null, 2));
    process.exit(1);
  }

  const ctx = await carregarContextoConfiguracaoInicial(supabase, uid);
  const snapshot = resolveConfigurationSnapshot({
    profile: ctx.profile,
    companies: ctx.companies ?? [],
    legalAcceptance: ctx.legalAcceptance,
  });

  const out = {
    ok: true,
    mission: "CARD.CONFIGURATION.ONBOARDING.01B",
    project_ref: projectRef,
    user_id_masked: `${uid.slice(0, 8)}…${uid.slice(-4)}`,
    load_ok: ctx.ok,
    load_warning: ctx.ok ? null : ctx.code,
    configuration: snapshot.configuration,
    milestones: snapshot.milestones.map((m) => ({
      id: m.id,
      status: m.status,
      action: m.action ?? null,
      dependency: m.dependency
        ? { required: m.dependency.required, m1_completed: m.dependency.m1_completed }
        : null,
    })),
    authorities: {
      company_resolution: snapshot.authorities.company_resolution,
      phone_audit: snapshot.authorities.phone_audit,
    },
    pii_policy: "no_email_no_cnpj_no_phone_in_output",
  };

  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: "PROBE_FAILED", message: error?.message ?? String(error) }));
  process.exit(1);
}
