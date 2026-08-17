#!/usr/bin/env node
/**
 * Puxa concorrentes recentes do Supabase e roda auditoria local
 * (mesmos logs S7_COMPETITION_* do pipeline de cadastro).
 *
 * Uso:
 *   node scripts/pull_competition_audit_logs.mjs
 *   node scripts/pull_competition_audit_logs.mjs MLB5550559084
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { runDirectItemSoldQuantityAudit } from "../src/domain/competition/competitionDirectItemAudit.js";
import {
  inferSalesHintBottleneck,
  logSalesPipelineSummary,
  logSalesPipelineTrace,
} from "../src/domain/competition/competitionSalesPipelineTrace.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

for (const f of [".env.local", ".env.vercel", ".env"]) loadEnv(path.join(root, f));

process.env.S7_COMPETITION_SALES_AUDIT = process.env.S7_COMPETITION_SALES_AUDIT || "1";
process.env.VERCEL_URL = process.env.VERCEL_URL || "suse7-backend-dev.vercel.app";

async function mlToken() {
  const res = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
    }),
  });
  const j = await res.json();
  if (!j?.access_token) throw new Error("ML token indisponível");
  return j.access_token;
}

async function latestCompetitors(limit = 5) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  const sb = createClient(url, key);
  const { data, error } = await sb
    .from("competition_competitors")
    .select(
      "id,competitor_listing_id,competitor_title,competitor_permalink,competitor_seller_id,source_strategy,created_at,last_captured_at"
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[pull_competition_audit_logs] supabase:", error.message);
    return [];
  }
  return data ?? [];
}

const itemArg = process.argv[2] ? String(process.argv[2]).trim() : null;

let itemId = itemArg;
if (!itemId) {
  const rows = await latestCompetitors(1);
  itemId = rows[0]?.competitor_listing_id ?? "MLB5550559084";
  if (rows[0]) {
    console.info("[pull_competition_audit_logs] usando concorrente mais recente do banco:", {
      competitor_id: rows[0].id,
      item_id: itemId,
      title: rows[0].competitor_title,
      created_at: rows[0].created_at,
    });
  } else {
    console.info("[pull_competition_audit_logs] sem linhas em competition_competitors; fallback:", itemId);
  }
}

const token = await mlToken();
const audit = await runDirectItemSoldQuantityAudit({
  accessToken: token,
  item_id: itemId,
  connected_seller_id: null,
  trigger: "manual_pull",
});

logSalesPipelineTrace("manual_pull_after_audit", {
  item_id: itemId,
  sales_hint: audit.resolution?.sales_hint ?? null,
  sales_hint_source: audit.resolution?.sales_hint_source ?? null,
  ml_resolved: audit.hit != null,
});

const verdict = inferSalesHintBottleneck({
  ml_resolved: audit.hit != null,
  ml_failure_class: audit.diagnosis?.failure_class_full ?? null,
  enrich_sales_hint: audit.resolution?.sales_hint ?? null,
  snapshot_sales_hint: null,
  api_response_sales_hint: null,
});

logSalesPipelineSummary({
  item_id: itemId,
  resolved: audit.resolved ?? false,
  scenario: audit.scenario ?? audit.diagnosis?.scenario ?? null,
  ml_endpoint_called: true,
  ml_http_status: audit.diagnosis?.full_status ?? null,
  ml_sold_quantity_evidence: audit.diagnosis?.full_sold_quantity_evidence ?? null,
  ml_sold_quantity_raw: audit.diagnosis?.sold_quantity_full?.sold_quantity_raw ?? null,
  ml_has_sold_quantity_field: audit.diagnosis?.sold_quantity_full?.field_present ?? null,
  ml_resolved: audit.hit != null,
  ml_failure_class: audit.diagnosis?.failure_class_full ?? null,
  is_third_party: audit.diagnosis?.is_third_party_listing ?? null,
  audit_recommendation: audit.diagnosis?.recommendation ?? null,
  sales_hint: audit.resolution?.sales_hint ?? null,
  sales_hint_source: audit.resolution?.sales_hint_source ?? null,
  bottleneck: verdict.bottleneck,
  recommendation: verdict.recommendation,
});
