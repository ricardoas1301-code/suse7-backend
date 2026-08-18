#!/usr/bin/env node
/**
 * Dedup controlado DEV — Fases A–G (sales_order_items via pipeline canônico ML).
 *
 * Uso:
 *   node scripts/dedup_sales_order_items_controlled.mjs snapshot
 *   node scripts/dedup_sales_order_items_controlled.mjs dry-run
 *   node scripts/dedup_sales_order_items_controlled.mjs execute [--batch-size 5] [--concurrency 2]
 *   node scripts/dedup_sales_order_items_controlled.mjs validate
 *   node scripts/dedup_sales_order_items_controlled.mjs audit
 *   node scripts/dedup_sales_order_items_controlled.mjs kpis
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import Decimal from "decimal.js";
import { fetchOrderById } from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import { persistMercadoLibreOrder, rebuildListingSalesMetricsForUser } from "../src/handlers/ml/_helpers/mlSalesPersist.js";
import { enrichMlOrderBuyerThumbnailIfNeeded } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { ML_MARKETPLACE_SLUG } from "../src/handlers/ml/_helpers/mlMarketplace.js";
import { resolveMercadoLivreOrderItemIdentity } from "../src/domain/sales/mercadoLivreOrderItemIdentity.js";
import { reconcileSalesOrderItemsGrossVsHeader } from "../src/handlers/ml/_helpers/salesOrderItemsCanonicalPersist.js";
import { buildSaleExecutiveSummary } from "../src/domain/sales/buildSaleExecutiveSummary.js";
import { resolveExecutiveSummaryPeriod } from "../src/domain/sales/saleExecutivePeriod.js";
import { pathToFileURL } from "node:url";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "output");
const RUN_ID = "DEDUP_DEV_2026-08-10";
const P0_DEPLOY_TIMESTAMP = "2026-08-10T19:42:03Z";
const EXCLUDED_MARKETPLACE_ACCOUNT_ID = "6d6a8486-5152-4d2d-9859-12917fae9f20";
const EXCLUDED_EXTERNAL_SELLER_ID = "677620487";
const TENANT_USER_ID = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";

const phase = process.argv[2] ?? "snapshot";
const batchSize = Number(process.argv.find((a, i) => process.argv[i - 1] === "--batch-size") ?? 5);
const concurrency = Number(process.argv.find((a, i) => process.argv[i - 1] === "--concurrency") ?? 2);

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function outPath(name) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, `${RUN_ID}_${name}.json`);
}

function fingerprintRow(row) {
  const listing = row.external_listing_id != null ? String(row.external_listing_id).trim() : "";
  const sku = row.sku_snapshot != null ? String(row.sku_snapshot).trim() : "";
  const qty = row.quantity != null ? String(row.quantity) : "";
  const unit = row.unit_price != null ? new Decimal(String(row.unit_price)).toFixed(2) : "";
  const gross = row.gross_amount != null ? new Decimal(String(row.gross_amount)).toFixed(2) : "";
  return `${listing}|${sku}|${qty}|${unit}|${gross}`;
}

async function fetchAllItems() {
  const rows = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("sales_order_items")
      .select(
        "id, sales_order_id, external_order_id, external_listing_id, sku_snapshot, quantity, unit_price, gross_amount, external_order_item_id, created_at, marketplace_account_id, user_id",
      )
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

function computeDuplicateAggregates(items) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const groups = new Map();
  for (const row of items) {
    const orderKey = String(row.sales_order_id ?? row.external_order_id ?? "unknown");
    const fp = fingerprintRow(row);
    const key = `${orderKey}::${fp}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicateGroups = [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => {
      const grossPerLine =
        list[0]?.gross_amount != null ? new Decimal(String(list[0].gross_amount)) : new Decimal(0);
      const extraRows = list.length - 1;
      return {
        group_key: key,
        external_order_id: list[0]?.external_order_id ?? null,
        sales_order_id: list[0]?.sales_order_id ?? null,
        marketplace_account_id: list[0]?.marketplace_account_id ?? null,
        fingerprint: fingerprintRow(list[0]),
        duplicate_count: list.length,
        extra_rows: extraRows,
        extra_gross: grossPerLine.times(extraRows).toFixed(2),
        item_ids: list.map((r) => r.id),
      };
    });

  let extraRows = 0;
  let extraGross = new Decimal(0);
  for (const g of duplicateGroups) {
    extraRows += g.extra_rows;
    extraGross = extraGross.plus(g.extra_gross);
  }

  return {
    duplicate_groups: duplicateGroups.length,
    extra_rows: extraRows,
    extra_gross_brl: extraGross.toFixed(2),
    duplicateGroups,
  };
}

async function discoverAffectedOrders() {
  const items = await fetchAllItems();
  const agg = computeDuplicateAggregates(items);

  /** @type {Map<string, { external_order_id: string; sales_order_id: string | null; marketplace_account_id: string | null; duplicate_groups: unknown[] }>} */
  const byOrder = new Map();
  for (const g of agg.duplicateGroups) {
    const oid = String(g.external_order_id ?? "");
    if (!oid) continue;
    if (!byOrder.has(oid)) {
      byOrder.set(oid, {
        external_order_id: oid,
        sales_order_id: g.sales_order_id != null ? String(g.sales_order_id) : null,
        marketplace_account_id: g.marketplace_account_id != null ? String(g.marketplace_account_id) : null,
        duplicate_groups: [],
      });
    }
    byOrder.get(oid).duplicate_groups.push(g);
  }

  const { data: orders } = await supabase
    .from("sales_orders")
    .select("id, external_order_id, marketplace_account_id, seller_company_id, total_amount, user_id")
    .in(
      "external_order_id",
      [...byOrder.keys()],
    );

  for (const o of orders ?? []) {
    const entry = byOrder.get(String(o.external_order_id));
    if (!entry) continue;
    entry.sales_order_id = String(o.id);
    entry.marketplace_account_id = String(o.marketplace_account_id);
    entry.seller_company_id = o.seller_company_id != null ? String(o.seller_company_id) : null;
    entry.total_amount = o.total_amount;
    entry.user_id = o.user_id != null ? String(o.user_id) : null;
  }

  const orderItemsBySalesOrder = new Map();
  for (const row of items) {
    const sid = String(row.sales_order_id ?? "");
    if (!sid) continue;
    if (!orderItemsBySalesOrder.has(sid)) orderItemsBySalesOrder.set(sid, []);
    orderItemsBySalesOrder.get(sid).push(row);
  }

  const ordersList = [...byOrder.values()].map((o) => {
    const sid = o.sales_order_id ?? "";
    const lines = sid ? orderItemsBySalesOrder.get(sid) ?? [] : [];
    const sumGross = lines.reduce(
      (acc, r) => acc.plus(r.gross_amount != null ? new Decimal(String(r.gross_amount)) : 0),
      new Decimal(0),
    );
    return {
      ...o,
      current_db_items: lines.length,
      fingerprints: lines.map(fingerprintRow),
      items: lines.map((r) => ({
        id: r.id,
        external_order_item_id: r.external_order_item_id,
        gross_amount: r.gross_amount,
        created_at: r.created_at,
        fingerprint: fingerprintRow(r),
      })),
      sum_gross_brl: sumGross.toFixed(2),
      excluded_677620487:
        o.marketplace_account_id === EXCLUDED_MARKETPLACE_ACCOUNT_ID,
    };
  });

  return { items, aggregates: agg, orders: ordersList };
}

function classifyOrderScope(order) {
  if (order.marketplace_account_id === EXCLUDED_MARKETPLACE_ACCOUNT_ID) {
    return {
      scope: "PENDING_SEPARATE_OAUTH_MULTI_TENANT_RESOLUTION",
      reason: `marketplace_account_id=${EXCLUDED_MARKETPLACE_ACCOUNT_ID} external_seller_id=${EXCLUDED_EXTERNAL_SELLER_ID}`,
    };
  }
  return { scope: "AUTHORIZED", reason: null };
}

async function resolveAccountForOrder(extOrderId) {
  const { data: existing } = await supabase
    .from("sales_orders")
    .select("user_id, marketplace_account_id, seller_company_id")
    .eq("marketplace", ML_MARKETPLACE_SLUG)
    .eq("external_order_id", extOrderId)
    .limit(1)
    .maybeSingle();

  if (existing?.user_id && existing?.marketplace_account_id) {
    return {
      userId: String(existing.user_id),
      marketplaceAccountId: String(existing.marketplace_account_id),
      sellerCompanyId: existing.seller_company_id != null ? String(existing.seller_company_id) : null,
    };
  }
  throw new Error(`sales_orders não encontrado para ${extOrderId}`);
}

function expectedCanonicalFromMl(detail) {
  const lines = Array.isArray(detail?.order_items) ? detail.order_items : [];
  const extOrderId = detail?.id != null ? String(detail.id) : "";
  const canonical = lines.map((line, lineIndex) => {
    const id = resolveMercadoLivreOrderItemIdentity(
      /** @type {Record<string, unknown>} */ (line),
      { externalOrderId: extOrderId, lineIndex, linesInOrder: lines },
    );
    return id.external_order_item_id;
  });
  const mlGross = lines.reduce((acc, line) => {
    const unit = line?.unit_price ?? line?.full_unit_price;
    const qty = line?.quantity ?? 1;
    if (unit == null) return acc;
    return acc.plus(new Decimal(String(unit)).times(String(qty)));
  }, new Decimal(0));
  return {
    official_ml_items: lines.length,
    expected_canonical_ids: canonical,
    official_gross_brl: mlGross.toFixed(2),
    header_amount_brl:
      detail?.total_amount != null ? new Decimal(String(detail.total_amount)).toFixed(2) : null,
  };
}

async function dryRunOrder(order) {
  const scope = classifyOrderScope(order);
  if (scope.scope !== "AUTHORIZED") {
    return { external_order_id: order.external_order_id, status: "BLOCKED", cause: scope.reason, scope: scope.scope };
  }

  try {
    const ctx = await resolveAccountForOrder(order.external_order_id);
    if (ctx.marketplaceAccountId === EXCLUDED_MARKETPLACE_ACCOUNT_ID) {
      return {
        external_order_id: order.external_order_id,
        status: "BLOCKED",
        cause: "excluded_marketplace_account",
        scope: "PENDING_SEPARATE_OAUTH_MULTI_TENANT_RESOLUTION",
      };
    }

    const accessToken = await getValidMLToken(ctx.userId, { marketplaceAccountId: ctx.marketplaceAccountId });
    const detail = await fetchOrderById(accessToken, order.external_order_id, {
      marketplaceAccountId: ctx.marketplaceAccountId,
    });
    const expected = expectedCanonicalFromMl(detail);

    const uniqueCanonical = new Set(expected.expected_canonical_ids);
    if (uniqueCanonical.size !== expected.expected_canonical_ids.length) {
      return {
        external_order_id: order.external_order_id,
        status: "BLOCKED",
        cause: "ambiguous_canonical_identity",
        ...expected,
        current_db_items: order.current_db_items,
      };
    }

    const header = expected.header_amount_brl;
    const mlGross = expected.official_gross_brl;
    if (header && mlGross && !new Decimal(header).minus(mlGross).abs().lte(new Decimal("0.05"))) {
      return {
        external_order_id: order.external_order_id,
        status: "BLOCKED",
        cause: "ml_header_vs_items_gross_mismatch",
        header_amount_brl: header,
        official_gross_brl: mlGross,
        current_db_items: order.current_db_items,
      };
    }

    const currentGross = order.sum_gross_brl;
    const headerDec = header ? new Decimal(header) : null;

    return {
      external_order_id: order.external_order_id,
      status: "SAFE",
      marketplace_account_id: ctx.marketplaceAccountId,
      seller_company_id: ctx.sellerCompanyId,
      current_db_items: order.current_db_items,
      official_ml_items: expected.official_ml_items,
      expected_canonical_items: expected.official_ml_items,
      current_gross_brl: currentGross,
      official_header_brl: header,
      expected_gross_after_brl: header ?? mlGross,
      duplicate_groups_in_order: order.duplicate_groups?.length ?? 0,
      max_duplicate_count: Math.max(...(order.duplicate_groups ?? []).map((g) => g.duplicate_count), 0),
    };
  } catch (e) {
    return {
      external_order_id: order.external_order_id,
      status: "ERROR",
      cause: e instanceof Error ? e.message : String(e),
    };
  }
}

async function executeOrder(orderMeta) {
  const extOrderId = orderMeta.external_order_id;
  const ctx = await resolveAccountForOrder(extOrderId);
  const accessToken = await getValidMLToken(ctx.userId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const detail = await fetchOrderById(accessToken, extOrderId, { marketplaceAccountId: ctx.marketplaceAccountId });
  const detailForPersist = await enrichMlOrderBuyerThumbnailIfNeeded(detail, accessToken, {
    marketplaceAccountId: ctx.marketplaceAccountId,
  });

  const out = await persistMercadoLibreOrder(supabase, ctx.userId, detailForPersist, {
    marketplace: ML_MARKETPLACE_SLUG,
    marketplaceAccountId: ctx.marketplaceAccountId,
    sellerCompanyId: ctx.sellerCompanyId,
    accessToken,
    traceCtx: { syncRunId: `dedup-dev:${extOrderId}`, syncType: "dedup_controlled" },
    log: (msg, extra) => console.log("[dedup-persist]", extOrderId, msg, extra ?? {}),
  });

  const salesOrderId = out?.salesOrderId != null ? String(out.salesOrderId) : null;
  if (!salesOrderId) throw new Error("sales_order_missing_after_persist");

  const { data: salesOrder, error: soErr } = await supabase
    .from("sales_orders")
    .select("id, total_amount")
    .eq("id", salesOrderId)
    .maybeSingle();
  if (soErr) throw soErr;
  if (!salesOrder?.id) throw new Error("sales_order_missing_after_persist");

  const { data: dbItems, error: iErr } = await supabase
    .from("sales_order_items")
    .select("id, external_order_item_id, gross_amount, quantity")
    .eq("sales_order_id", salesOrder.id);
  if (iErr) throw iErr;

  const mlExpected = expectedCanonicalFromMl(detail);
  const nullLegacy = (dbItems ?? []).filter((r) => !r.external_order_item_id);
  const recon = reconcileSalesOrderItemsGrossVsHeader(salesOrder.total_amount, dbItems ?? []);

  let validation = "OK";
  if ((dbItems ?? []).length !== mlExpected.official_ml_items) validation = "ITEM_COUNT_MISMATCH";
  else if (nullLegacy.length > 0) validation = "NULL_LEGACY_RESIDUAL";
  else if (!recon.ok && !recon.skipped) validation = "GROSS_RECON_MISMATCH";

  return {
    external_order_id: extOrderId,
    ok: validation === "OK",
    validation,
    ml_official_items: mlExpected.official_ml_items,
    db_items: (dbItems ?? []).length,
    null_legacy_count: nullLegacy.length,
    reconciliation: recon,
    user_id: ctx.userId,
  };
}

async function runPool(items, worker, limit) {
  const results = [];
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

async function phaseSnapshot() {
  const discovered = await discoverAffectedOrders();
  const payload = {
    generated_at_utc: new Date().toISOString(),
    run_id: RUN_ID,
    phase: "A_SNAPSHOT",
    aggregates: {
      duplicate_groups: discovered.aggregates.duplicate_groups,
      extra_rows: discovered.aggregates.extra_rows,
      extra_gross_brl: discovered.aggregates.extra_gross_brl,
    },
    orders_count: discovered.orders.length,
    excluded_677620487_count: discovered.orders.filter((o) => o.excluded_677620487).length,
    authorized_max: discovered.orders.filter((o) => !o.excluded_677620487).length,
    orders: discovered.orders,
  };
  fs.writeFileSync(outPath("SNAPSHOT_PRE_DEDUP"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ ok: true, file: outPath("SNAPSHOT_PRE_DEDUP"), ...payload.aggregates, orders_count: payload.orders_count }, null, 2));
}

async function phaseDryRun() {
  const snapPath = outPath("SNAPSHOT_PRE_DEDUP");
  if (!fs.existsSync(snapPath)) await phaseSnapshot();
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  const orders = snap.orders ?? [];

  const results = [];
  for (let i = 0; i < orders.length; i++) {
    const r = await dryRunOrder(orders[i]);
    results.push(r);
    if ((i + 1) % 20 === 0) console.error(`[dry-run] ${i + 1}/${orders.length}`);
    await new Promise((res) => setTimeout(res, 150));
  }

  const safe = results.filter((r) => r.status === "SAFE");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  const errors = results.filter((r) => r.status === "ERROR");

  const payload = {
    generated_at_utc: new Date().toISOString(),
    phase: "B_DRY_RUN",
    counts: { SAFE: safe.length, BLOCKED: blocked.length, ERROR: errors.length },
    safe_external_order_ids: safe.map((r) => r.external_order_id),
    results,
  };
  fs.writeFileSync(outPath("DRY_RUN"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ ok: true, file: outPath("DRY_RUN"), ...payload.counts }, null, 2));
}

async function phaseExecute() {
  const dryPath = outPath("DRY_RUN");
  if (!fs.existsSync(dryPath)) {
    console.error("Execute dry-run primeiro");
    process.exit(2);
  }
  const dry = JSON.parse(fs.readFileSync(dryPath, "utf8"));
  const safeMeta = (dry.results ?? []).filter((r) => r.status === "SAFE");

  const progressPath = outPath("EXECUTE_PROGRESS");
  const progress = fs.existsSync(progressPath)
    ? JSON.parse(fs.readFileSync(progressPath, "utf8"))
    : {
        started_at_utc: new Date().toISOString(),
        batch_size: batchSize,
        concurrency,
        total: safeMeta.length,
        processed: [],
        failed: [],
      };

  const doneIds = new Set([
    ...(progress.processed ?? []).map((p) => p.external_order_id),
    ...(progress.failed ?? []).map((p) => p.external_order_id),
  ]);
  const pending = safeMeta.filter((m) => !doneIds.has(m.external_order_id));
  progress.batch_size = batchSize;
  progress.concurrency = concurrency;
  progress.resumed_at_utc = new Date().toISOString();
  progress.pending_count = pending.length;

  for (let b = 0; b < pending.length; b += batchSize) {
    const batch = pending.slice(b, b + batchSize);
    console.error(`[execute] batch ${Math.floor(b / batchSize) + 1} orders ${b + 1}-${b + batch.length}/${pending.length} (total safe ${safeMeta.length})`);
    const batchResults = await runPool(
      batch,
      async (meta) => {
        try {
          const r = await executeOrder(meta);
          return r;
        } catch (e) {
          return {
            external_order_id: meta.external_order_id,
            ok: false,
            validation: "EXEC_ERROR",
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      concurrency,
    );
    for (const r of batchResults) {
      if (r.ok) progress.processed.push(r);
      else progress.failed.push(r);
    }
    fs.writeFileSync(outPath("EXECUTE_PROGRESS"), JSON.stringify(progress, null, 2));
    await new Promise((res) => setTimeout(res, 2000));
  }

  const users = [...new Set(progress.processed.map((p) => p.user_id).filter(Boolean))];
  for (const userId of users) {
    try {
      await rebuildListingSalesMetricsForUser(supabase, userId, ML_MARKETPLACE_SLUG, () => {});
    } catch (e) {
      console.error("[metrics] rebuild_warn", userId, e instanceof Error ? e.message : String(e));
    }
  }

  progress.finished_at_utc = new Date().toISOString();
  fs.writeFileSync(outPath("EXECUTE_RESULT"), JSON.stringify(progress, null, 2));
  console.log(
    JSON.stringify(
      {
        ok: progress.failed.length === 0,
        processed: progress.processed.length,
        failed: progress.failed.length,
        file: outPath("EXECUTE_RESULT"),
      },
      null,
      2,
    ),
  );
}

async function phaseValidate() {
  const execPath = outPath("EXECUTE_RESULT");
  if (!fs.existsSync(execPath)) {
    console.error("Execute primeiro");
    process.exit(2);
  }
  const exec = JSON.parse(fs.readFileSync(execPath, "utf8"));
  const all = [...(exec.processed ?? []), ...(exec.failed ?? [])];
  const payload = {
    generated_at_utc: new Date().toISOString(),
    phase: "D_VALIDATE",
    ok_count: (exec.processed ?? []).filter((r) => r.validation === "OK").length,
    issues: all.filter((r) => !r.ok || r.validation !== "OK"),
    reconciliation_ok: (exec.processed ?? []).filter((r) => r.reconciliation?.ok).length,
    reconciliation_blocked: (exec.processed ?? []).filter((r) => r.reconciliation && !r.reconciliation.ok && !r.reconciliation.skipped),
  };
  fs.writeFileSync(outPath("VALIDATE"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

async function phaseAudit() {
  const items = await fetchAllItems();
  const agg = computeDuplicateAggregates(items);

  const postDeploy = agg.duplicateGroups.filter((g) => {
    const orderId = g.external_order_id;
    return orderId;
  });

  const nullLegacy = items.filter((r) => r.external_order_item_id == null || String(r.external_order_item_id).trim() === "");

  const excludedOrders = await supabase
    .from("sales_orders")
    .select("external_order_id, id")
    .eq("marketplace_account_id", EXCLUDED_MARKETPLACE_ACCOUNT_ID);

  const payload = {
    generated_at_utc: new Date().toISOString(),
    phase: "F_AUDIT_POST_DEDUP",
    duplicate_groups: agg.duplicate_groups,
    extra_rows: agg.extra_rows,
    extra_gross_brl: agg.extra_gross_brl,
    null_legacy_rows_total: nullLegacy.length,
    null_legacy_in_excluded_account: nullLegacy.filter((r) => r.marketplace_account_id === EXCLUDED_MARKETPLACE_ACCOUNT_ID).length,
    excluded_677620487_orders: (excludedOrders.data ?? []).map((o) => o.external_order_id),
    p0_deploy_timestamp: P0_DEPLOY_TIMESTAMP,
  };

  const afterItems = await fetchAllItems();
  const afterAgg = computeDuplicateAggregates(afterItems);
  const postP0New = afterAgg.duplicateGroups.filter((g) => {
    return false;
  });

  payload.new_duplicates_post_p0 = {
    note: "use audit_sales_order_items_duplicates_readonly.mjs --after for precise filter",
    deploy_timestamp: P0_DEPLOY_TIMESTAMP,
  };

  fs.writeFileSync(outPath("AUDIT_POST_DEDUP"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

async function phaseKpis() {
  const repoRoot = path.resolve(__dirname, "../..");
  const { resolveOperationalDayCycle } = await import(
    pathToFileURL(path.join(repoRoot, "suse7-frontend/src/features/dashboard/operationalDayCycle.js")).href
  );
  const { data: profile } = await supabase
    .from("profiles")
    .select("operational_day_closes_at, operational_working_days")
    .eq("id", TENANT_USER_ID)
    .maybeSingle();

  const cycle = resolveOperationalDayCycle({
    now: new Date(),
    closesAt: profile?.operational_day_closes_at ?? "18:00",
    workingDays: profile?.operational_working_days ?? ["mon", "tue", "wed", "thu", "fri"],
    timezone: "America/Sao_Paulo",
  });

  const periodResolved = resolveExecutiveSummaryPeriod({
    start_datetime: cycle.startDatetimeIso,
    end_datetime: cycle.endDatetimeIso,
    period_preset: "operational_cycle",
  });
  if (!periodResolved.ok) throw new Error(periodResolved.error ?? "period_resolve_failed");

  const summary = await buildSaleExecutiveSummary(supabase, TENANT_USER_ID, {
    period: periodResolved.period,
    marketplace: ML_MARKETPLACE_SLUG,
  });

  const refStart = "2026-08-07T21:00:00.000Z";
  const refEnd = new Date().toISOString();
  const refPeriod = resolveExecutiveSummaryPeriod({
    start_datetime: refStart,
    end_datetime: refEnd,
    period_preset: "operational_cycle",
  });
  const refSummary =
    refPeriod.ok &&
    (await buildSaleExecutiveSummary(supabase, TENANT_USER_ID, {
      period: refPeriod.period,
      marketplace: ML_MARKETPLACE_SLUG,
    }));

  const cards = summary?.cards ?? summary?.summary ?? summary;
  const payload = {
    generated_at_utc: new Date().toISOString(),
    phase: "G_VENDAS_AO_VIVO",
    cycle: {
      label: cycle.labelCompact,
      start_datetime: cycle.startDatetimeIso,
      end_datetime: cycle.endDatetimeIso,
    },
    kpis: cards,
    reference_cycle_07_08_18h: refSummary?.cards ?? refSummary?.summary ?? refSummary ?? null,
    reference_cycle_label: "07/08 18:00 – agora (referência pré-dedup Rico)",
    rankings: {
      top_products: summary?.rankings?.by_revenue ?? summary?.rankings?.top_products ?? null,
      by_account: summary?.rankings?.by_account ?? null,
    },
    note: "Medição somente — fórmulas não alteradas",
  };
  fs.writeFileSync(outPath("KPIS_VENDAS_AO_VIVO"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ ok: true, file: outPath("KPIS_VENDAS_AO_VIVO"), cycle: payload.cycle, cards: payload.kpis }, null, 2));
}

async function main() {
  switch (phase) {
    case "snapshot":
      await phaseSnapshot();
      break;
    case "dry-run":
      await phaseDryRun();
      break;
    case "execute":
      await phaseExecute();
      break;
    case "validate":
      await phaseValidate();
      break;
    case "audit":
      await phaseAudit();
      break;
    case "kpis":
      await phaseKpis();
      break;
    default:
      console.error(`Fase desconhecida: ${phase}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
