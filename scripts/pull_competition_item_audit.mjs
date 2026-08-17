#!/usr/bin/env node
/** Auditoria de um item com token OAuth do seller (ml_tokens). */
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
const itemId = String(process.argv[2] || "MLB51850422").trim();

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
process.env.S7_COMPETITION_SALES_AUDIT = "1";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: comp } = await sb
  .from("competition_competitors")
  .select("id,user_id,competitor_listing_id,competitor_seller_id,product_id,created_at")
  .eq("competitor_listing_id", itemId)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

const { data: tokRow } = comp?.user_id
  ? await sb
      .from("ml_tokens")
      .select("access_token,ml_user_id,expires_at")
      .eq("user_id", comp.user_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  : { data: null };

let ownListingId = null;
if (comp?.product_id) {
  const { data: listing } = await sb
    .from("marketplace_listings")
    .select("external_listing_id")
    .eq("product_id", comp.product_id)
    .eq("marketplace", "mercado_livre")
    .limit(1)
    .maybeSingle();
  ownListingId = listing?.external_listing_id ?? null;
}

const accessToken = tokRow?.access_token ?? null;
const connectedSellerId = tokRow?.ml_user_id != null ? String(tokRow.ml_user_id) : null;

console.info("[pull_item_audit] context", {
  item_id: itemId,
  competitor_id: comp?.id ?? null,
  competitor_seller_id: comp?.competitor_seller_id ?? null,
  connected_seller_id: connectedSellerId,
  own_listing_id: ownListingId,
  has_seller_token: Boolean(accessToken),
  token_expires_at: tokRow?.expires_at ?? null,
});

if (!accessToken) {
  console.error("Sem token OAuth do seller em ml_tokens");
  process.exit(1);
}

const audit = await runDirectItemSoldQuantityAudit({
  accessToken,
  item_id: itemId,
  connected_seller_id: connectedSellerId,
  own_listing_id: ownListingId,
  trigger: "manual_pull_seller_token",
});

logSalesPipelineTrace("manual_pull_seller_token", {
  item_id: itemId,
  competitor_id: comp?.id ?? null,
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
  competitor_id: comp?.id ?? null,
  resolved: audit.resolved ?? false,
  scenario: audit.scenario ?? null,
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
