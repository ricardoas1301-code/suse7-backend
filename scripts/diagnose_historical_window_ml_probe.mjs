#!/usr/bin/env node
/**
 * P0.2-N — Probe READ-ONLY da primeira página ML para janela histórica.
 * Não altera jobs, não persiste pedidos, não faz claim/lease.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  searchSellerOrdersPage,
  resolveMlOrdersSearchSort,
} from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { buildHistoricalSalesBackfillWindows } from "../src/services/marketplace/mlSalesHistoryWindow.js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const WINDOW3_ID = process.argv.find((a) => a.startsWith("--job-id="))?.split("=")[1] || "8f08e2c5-52ab-4e0d-b804-babf9feef6ef";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "..", "scripts", "output");

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = {
  ...parseEnvFile(path.join(root, ".env.local")),
  ...parseEnvFile(path.join(root, ".env.vercel")),
  ...process.env,
};
for (const [k, v] of Object.entries(env)) {
  if (v != null && String(v).trim() !== "") process.env[k] = String(v);
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** @param {string} dateFrom @param {string} dateTo @param {number} limit */
async function probeRange(accessToken, sellerId, dateFrom, dateTo, limit = 50) {
  const sort = resolveMlOrdersSearchSort();
  const t0 = Date.now();
  let page;
  let httpStatus = 200;
  try {
    page = await searchSellerOrdersPage(accessToken, sellerId, 0, limit, {
      dateFrom,
      dateTo,
      marketplaceAccountId: INSPRAZZO_ACCOUNT,
      sort,
    });
  } catch (e) {
    httpStatus = e && typeof e === "object" && "status" in e ? Number(/** @type {{ status?: number }} */ (e).status) : 0;
    return {
      label: `${dateFrom} → ${dateTo}`,
      http_status: httpStatus || null,
      duration_ms: Date.now() - t0,
      error: e?.message ? String(e.message).slice(0, 500) : String(e).slice(0, 500),
      sort,
      query_params: {
        seller: sellerId,
        offset: 0,
        limit,
        sort,
        "order.date_created.from": dateFrom,
        "order.date_created.to": dateTo,
      },
    };
  }

  const results = Array.isArray(page?.rawResults) ? page.rawResults : [];
  const orderIds = page?.orderIds || [];
  const safeResults = orderIds.slice(0, 5).map((id, i) => {
    const raw = results[i];
    const dc = raw && typeof raw === "object" && raw.date_created != null ? String(raw.date_created) : null;
    return { order_id: id, date_created: dc };
  });

  return {
    label: `${dateFrom} → ${dateTo}`,
    http_status: httpStatus,
    duration_ms: Date.now() - t0,
    sort,
    query_params: {
      seller: sellerId,
      offset: 0,
      limit,
      sort,
      "order.date_created.from": dateFrom,
      "order.date_created.to": dateTo,
    },
    paging: {
      total: page?.paging?.total ?? null,
      offset: page?.paging?.offset ?? 0,
      limit: page?.paging?.limit ?? limit,
    },
    results_length: orderIds.length,
    sample_order_ids: safeResults,
  };
}

const { data: job } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", WINDOW3_ID).maybeSingle();
if (!job) {
  console.error(JSON.stringify({ ok: false, error: "job_not_found", job_id: WINDOW3_ID }));
  process.exit(2);
}

const meta = readJobMetadataObject(job);
const dateFrom = meta.date_from != null ? String(meta.date_from).trim() : "";
const dateTo = meta.date_to != null ? String(meta.date_to).trim() : "";

const { data: account } = await sb
  .from("marketplace_accounts")
  .select("id,user_id,external_seller_id,seller_company_id")
  .eq("id", INSPRAZZO_ACCOUNT)
  .maybeSingle();

const sellerId = account?.external_seller_id ? String(account.external_seller_id) : "";
const userId = account?.user_id ? String(account.user_id) : "";

let accessToken;
try {
  accessToken = await getValidMLToken(userId, { marketplaceAccountId: INSPRAZZO_ACCOUNT });
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: "token_failed", message: e?.message ?? String(e) }));
  process.exit(3);
}

const { data: allHist } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,status,progress_current,progress_total,metadata,created_at")
  .eq("marketplace_account_id", INSPRAZZO_ACCOUNT)
  .eq("job_type", "ml_historical_sales_backfill")
  .order("created_at", { ascending: true });

const gridRanges = (allHist ?? []).map((r) => {
  const m = readJobMetadataObject(r);
  return {
    job_id: r.id,
    window_index: m.window_index ?? null,
    status: r.status,
    progress: `${r.progress_current ?? 0}/${r.progress_total ?? "?"}`,
    date_from: m.date_from ?? null,
    date_to: m.date_to ?? null,
    target_history_end_iso: m.target_history_end_iso ?? null,
    hot_end_iso: m.hot_end_iso ?? null,
  };
});

const cutover = meta.target_history_end_iso || meta.cutover_iso || meta.hot_end_iso;
const builder = cutover ? buildHistoricalSalesBackfillWindows(cutover) : null;

const DAY_MS = 86400000;
const borderProbes = [];
if (dateFrom && dateTo) {
  borderProbes.push(await probeRange(accessToken, sellerId, dateFrom, dateTo, 50));
  const fromTs = Date.parse(dateFrom);
  const toTs = Date.parse(dateTo);
  if (Number.isFinite(fromTs)) {
    borderProbes.push(
      await probeRange(
        accessToken,
        sellerId,
        new Date(fromTs - 3 * DAY_MS).toISOString(),
        dateTo,
        50
      )
    );
  }
  if (Number.isFinite(toTs)) {
    borderProbes.push(
      await probeRange(
        accessToken,
        sellerId,
        dateFrom,
        new Date(toTs + 3 * DAY_MS).toISOString(),
        50
      )
    );
  }
}

const report = {
  generated_at: new Date().toISOString(),
  mission: "P0.2-N",
  read_only: true,
  job_snapshot: {
    job_id: job.id,
    status: job.status,
    progress_current: job.progress_current ?? 0,
    progress_total: job.progress_total ?? null,
    last_cursor: job.last_cursor ?? null,
    updated_at: job.updated_at,
    window_index: meta.window_index ?? null,
    date_from: dateFrom,
    date_to: dateTo,
    target_history_end_iso: meta.target_history_end_iso ?? null,
    hot_end_iso: meta.hot_end_iso ?? null,
    historical_period_start: meta.historical_period_start ?? null,
    historical_period_end: meta.historical_period_end ?? null,
    lease_owner: meta.lease_owner ?? null,
    lease_version: meta.lease_version ?? null,
    lease_expires_at: meta.lease_expires_at ?? null,
    heartbeat_at: meta.heartbeat_at ?? null,
    recovery_count: meta.recovery_count ?? 0,
    metadata_keys: Object.keys(meta).sort(),
  },
  timezone_contract: {
    stored: "ISO8601 UTC (Z suffix in metadata)",
    sent_to_ml: "order.date_created.from / order.date_created.to — ISO strings as stored, no local conversion",
    temporal_field: "order.date_created",
    sort: resolveMlOrdersSearchSort(),
    boundary: "builder: backfill [start, hot_start) half-open; API uses inclusive from/to on date_created",
  },
  seller_id: sellerId,
  grid_ranges: gridRanges,
  builder_replay: builder
    ? {
        cutover_iso: builder.cutover_iso,
        backfill_start_iso: builder.backfill_start_iso,
        backfill_end_iso: builder.backfill_end_iso,
        hot_start_iso: builder.hot_start_iso,
        hot_end_iso: builder.hot_end_iso,
        chunk_days: builder.chunk_days,
        windows: builder.windows.map((w) => ({
          window_index: w.window_index,
          date_from: w.date_from,
          date_to: w.date_to,
        })),
      }
    : null,
  primary_probe: borderProbes[0] ?? null,
  border_probes: borderProbes,
  verdict_hint:
    borderProbes[0]?.paging?.total === 0 && borderProbes[0]?.results_length === 0
      ? "EMPTY_WINDOW_LIKELY"
      : borderProbes[0]?.paging?.total > 0 || borderProbes[0]?.results_length > 0
        ? "NOT_EMPTY"
        : "INCONCLUSIVE",
};

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `DIAGNOSE_HISTORICAL_WINDOW_ML_PROBE_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, out_path: outPath, verdict_hint: report.verdict_hint, primary: report.primary_probe }, null, 2));
