#!/usr/bin/env node
/**
 * Backfill DEV — snapshots financeiros historicos (SSOT).
 *
 * Objetivo:
 * - Reenriquecer vendas com _s7_financial incompleto
 * - Sem sobrescrever snapshot completo existente
 * - Preencher somente campos ausentes
 * - Gerar relatorio PASS/FAIL por item e resumo operacional
 *
 * Uso:
 *   node scripts/backfill_financial_snapshots_dev.mjs --execute --confirm-dev
 *   node scripts/backfill_financial_snapshots_dev.mjs --execute --confirm-dev --limit 500
 *   node scripts/backfill_financial_snapshots_dev.mjs --dry-run --confirm-dev
 */

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";
import { buildSaleDetailMarketplaceRevenue } from "../src/domain/sales/saleDetailMarketplaceRevenue.js";
import {
  ML_FINANCIAL_SNAPSHOT_VERSION,
} from "../src/domain/sales/mercadoLivreSaleRevenueRules.js";
import {
  buildSaleDetailInternalCostsContract,
  computeSaleDetailRealResult,
  resolveSaleInternalTaxProfile,
  saleDetailMoneyToDecimal as toMoneyDecimal,
  saleDetailToQty as toQty,
} from "../src/domain/sales/saleDetailInternalCosts.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const arg = (name, fallback = null) => {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] != null ? String(args[idx + 1]) : fallback;
};

const EXECUTE = hasFlag("--execute");
const DRY_RUN = hasFlag("--dry-run") || !EXECUTE;
const CONFIRM_DEV = hasFlag("--confirm-dev");
const LIMIT = Math.max(1, Math.min(5000, Number.parseInt(arg("--limit", "1000"), 10) || 1000));
const OFFSET = Math.max(0, Number.parseInt(arg("--offset", "0"), 10) || 0);
const ITEM_ID = arg("--item-id", null);
const VALIDATE_LIMIT = Math.max(1, Math.min(200, Number.parseInt(arg("--validate-limit", "40"), 10) || 40));
const API_BASE = String(arg("--api-base", process.env.S7_API_BASE || "http://localhost:3001")).replace(/\/+$/, "");
const OUTPUT_FILE = arg(
  "--output",
  path.join("scripts", "output", `backfill_financial_snapshots_dev_${Date.now()}.json`),
);
const VERBOSE = hasFlag("--verbose");

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Env obrigatoria ausente: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

if (!CONFIRM_DEV) {
  console.error("Seguranca DEV: use --confirm-dev para executar este script.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const originalConsoleLog = console.log.bind(console);
if (!VERBOSE) {
  console.log = (...args) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("[S7 RAYX REBATE RESOLVE]")) return;
    originalConsoleLog(...args);
  };
}

function isUuidLike(v) {
  const s = v != null ? String(v).trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function toObj(v) {
  return v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : null;
}

function toTrim(v) {
  if (v == null) return "";
  return String(v).trim();
}

function pickFinancial(rawJson) {
  const raw = toObj(rawJson);
  const fin = raw?._s7_financial;
  return toObj(fin);
}

function isMissingValue(v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

function cloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

function fillMissingDeep(target, source) {
  if (!toObj(source)) return { value: target, changed: false };
  const t = toObj(target) ? /** @type {Record<string, unknown>} */ (target) : {};
  let changed = false;
  for (const [key, sVal] of Object.entries(/** @type {Record<string, unknown>} */ (source))) {
    const tVal = t[key];
    if (toObj(sVal)) {
      if (!toObj(tVal)) {
        t[key] = cloneJson(sVal);
        changed = true;
      } else {
        const nested = fillMissingDeep(tVal, sVal);
        if (nested.changed) {
          t[key] = nested.value;
          changed = true;
        }
      }
      continue;
    }
    if (isMissingValue(tVal) && !isMissingValue(sVal)) {
      t[key] = sVal;
      changed = true;
    }
  }
  return { value: t, changed };
}

function inferSnapshotOrigin(fin) {
  const origin = toTrim(fin?.snapshot_origin).toLowerCase();
  if (origin === "onboarding_import" || origin === "post_suse7_sale") return origin;
  const quality = toTrim(fin?.snapshot_quality).toLowerCase();
  if (quality === "reconstructed") return "onboarding_import";
  return "post_suse7_sale";
}

function resolveSnapshotMetaMissingOnly(fin, nowIso) {
  const origin = inferSnapshotOrigin(fin);
  const isOnboarding = origin === "onboarding_import";
  const estimatedDerived = isOnboarding;
  const qualityDerived = isOnboarding ? "reconstructed" : "historical";

  return {
    snapshot_origin: origin,
    snapshot_quality: qualityDerived,
    estimated: typeof fin?.estimated === "boolean" ? fin.estimated : estimatedDerived,
    reconstructed_at:
      isOnboarding && isMissingValue(fin?.reconstructed_at) ? nowIso : fin?.reconstructed_at ?? null,
    reconstruction_reference_date:
      isOnboarding && isMissingValue(fin?.reconstruction_reference_date)
        ? nowIso
        : fin?.reconstruction_reference_date ?? null,
    snapshot_created_at:
      !isOnboarding && isMissingValue(fin?.snapshot_created_at) ? nowIso : fin?.snapshot_created_at ?? null,
    immutable_since: isMissingValue(fin?.immutable_since) ? nowIso : fin?.immutable_since ?? null,
    snapshot_version:
      isMissingValue(fin?.snapshot_version) ? ML_FINANCIAL_SNAPSHOT_VERSION : fin?.snapshot_version ?? null,
  };
}

function buildContingencyFromFinancial(fin) {
  const snap = toObj(fin?.contingency_margin_snapshot);
  const adsSnap = toObj(fin?.ads_snapshot);
  const operationalSnap = toObj(fin?.operational_cost_snapshot);
  /** @type {Array<Record<string, unknown>>} */
  const lines = [];
  const mlAds =
    snap?.ml_ads_brl ??
    snap?.ml_ads_amount_brl ??
    adsSnap?.amount_brl ??
    adsSnap?.ml_ads_brl ??
    null;
  if (!isMissingValue(mlAds)) {
    lines.push({
      key: "ml_ads",
      amount_brl: String(mlAds),
    });
  }
  const reserve =
    snap?.reserve_brl ??
    snap?.safety_reserve_brl ??
    snap?.reserve_amount_brl ??
    operationalSnap?.reserve_brl ??
    operationalSnap?.operational_costs_brl ??
    null;
  if (!isMissingValue(reserve)) {
    lines.push({
      key: "safety_reserve",
      amount_brl: String(reserve),
    });
  }
  if (lines.length === 0) return null;
  return lines;
}

function sumContingency(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = new Decimal(0);
  let any = false;
  for (const row of lines) {
    if (!row || typeof row !== "object") continue;
    const dec = toMoneyDecimal(row.amount_brl);
    if (dec != null && dec.gt(0)) {
      total = total.plus(dec);
      any = true;
    }
  }
  return any ? total : null;
}

function buildMissingSnapshotsContract(ctx) {
  const {
    item,
    order,
    listing,
    product,
    taxProfile,
    existingFin,
    nowIso,
  } = ctx;
  const snapshotMeta = resolveSnapshotMetaMissingOnly(existingFin, nowIso);

  const qty = toQty(item.quantity);
  const revenue = buildSaleDetailMarketplaceRevenue(item, order ?? null, listing ?? null);
  const grossDec = toMoneyDecimal(revenue.gross_amount);
  const netDec = toMoneyDecimal(revenue.net_received_amount);

  const productId =
    product?.id != null && isUuidLike(product.id)
      ? String(product.id)
      : listing?.product_id != null && isUuidLike(listing.product_id)
        ? String(listing.product_id)
        : null;

  const internalCosts = buildSaleDetailInternalCostsContract({
    item,
    product: product ?? null,
    productId,
    qty,
    grossDec,
    taxPercent: taxProfile?.tax_percent != null ? String(taxProfile.tax_percent) : null,
    taxPercentSource: taxProfile?.source != null ? String(taxProfile.source) : null,
    seller_company_id:
      taxProfile?.seller_company_id != null ? String(taxProfile.seller_company_id) : null,
    marketplace_account_id:
      taxProfile?.marketplace_account_id != null ? String(taxProfile.marketplace_account_id) : null,
  });

  const contingency = buildContingencyFromFinancial(existingFin);
  const contingencyDec = sumContingency(contingency);
  const real = computeSaleDetailRealResult({
    netReceivedDec: netDec,
    internalCosts,
    contingencyDec,
  });
  const marginPercent =
    real.profitDec != null && grossDec != null && !grossDec.isZero()
      ? real.profitDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : null;

  const existingOperational = toObj(existingFin?.operational_cost_snapshot);
  const reserveFromExisting =
    existingOperational?.reserve_brl ??
    existingOperational?.operational_costs_brl ??
    toObj(existingFin?.contingency_margin_snapshot)?.reserve_brl ??
    toObj(existingFin?.contingency_margin_snapshot)?.safety_reserve_brl ??
    null;
  const adsFromExisting =
    toObj(existingFin?.ads_snapshot)?.amount_brl ??
    toObj(existingFin?.contingency_margin_snapshot)?.ml_ads_brl ??
    null;

  const estimatedFlag =
    typeof snapshotMeta.estimated === "boolean"
      ? snapshotMeta.estimated
      : internalCosts.confidence !== "persisted";

  return {
    snapshot_origin: snapshotMeta.snapshot_origin,
    snapshot_quality: snapshotMeta.snapshot_quality,
    estimated: estimatedFlag,
    reconstructed_at: snapshotMeta.reconstructed_at,
    reconstruction_reference_date: snapshotMeta.reconstruction_reference_date,
    snapshot_created_at: snapshotMeta.snapshot_created_at,
    immutable_since: snapshotMeta.immutable_since,
    snapshot_version: snapshotMeta.snapshot_version,
    internal_costs_snapshot: {
      product_cost_brl: internalCosts.product_cost_brl,
      internal_tax_brl: internalCosts.internal_tax_brl,
      packaging_cost_brl: internalCosts.packaging_cost_brl,
      operation_cost_brl: internalCosts.operation_cost_brl,
      operation_packaging_cost_brl: internalCosts.operation_packaging_cost_brl,
      total_internal_cost_brl: internalCosts.total_internal_cost_brl,
      tax_percent_applied: internalCosts.tax_percent_applied,
      source: internalCosts.source,
      confidence: internalCosts.confidence,
      snapshot_quality: snapshotMeta.snapshot_quality,
      snapshot_version: "s7_internal_costs_v1",
      estimated: estimatedFlag,
      seller_company_id: internalCosts.seller_company_id,
      marketplace_account_id: internalCosts.marketplace_account_id,
    },
    product_cost_snapshot: {
      amount_brl: internalCosts.product_cost_brl,
      source: internalCosts.source?.product_cost ?? null,
      estimated: estimatedFlag,
    },
    tax_snapshot: {
      amount_brl: internalCosts.internal_tax_brl,
      tax_percent_applied: internalCosts.tax_percent_applied,
      source: internalCosts.source?.internal_tax ?? null,
      estimated: estimatedFlag,
    },
    operational_cost_snapshot: {
      operation_packaging_cost_brl: internalCosts.operation_packaging_cost_brl,
      operation_cost_brl: internalCosts.operation_cost_brl,
      packaging_cost_brl: internalCosts.packaging_cost_brl,
      reserve_brl: !isMissingValue(reserveFromExisting) ? String(reserveFromExisting) : null,
      source: internalCosts.source?.operation_packaging ?? null,
      estimated: estimatedFlag,
    },
    ads_snapshot: {
      amount_brl: !isMissingValue(adsFromExisting) ? String(adsFromExisting) : null,
      source: !isMissingValue(adsFromExisting) ? "historical_financial_snapshot" : null,
      estimated: estimatedFlag,
    },
    profit_snapshot: {
      amount_brl:
        real.profitDec != null
          ? real.profitDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
          : null,
      source: "net_received_minus_internal_costs",
      confidence: real.confidence,
      estimated: estimatedFlag || !real.is_definitive,
    },
    margin_snapshot: {
      percent: marginPercent,
      source: "profit_snapshot_over_gross_sale",
      estimated: estimatedFlag || !real.is_definitive,
    },
  };
}

function isFinancialSnapshotBackfillComplete(fin) {
  if (!toObj(fin)) return false;
  const requiredTop = [
    "snapshot_origin",
    "snapshot_quality",
    "estimated",
    "immutable_since",
    "snapshot_version",
  ];
  const requiredObjects = [
    "internal_costs_snapshot",
    "product_cost_snapshot",
    "tax_snapshot",
    "operational_cost_snapshot",
    "ads_snapshot",
    "profit_snapshot",
    "margin_snapshot",
  ];
  for (const key of requiredTop) {
    if (isMissingValue(fin[key])) return false;
  }
  for (const key of requiredObjects) {
    if (!toObj(fin[key])) return false;
  }
  return true;
}

async function resolveAccessTokenForUser(userId) {
  const { data: userRes, error } = await sb.auth.admin.getUserById(String(userId));
  if (error) throw error;
  const email = userRes?.user?.email;
  if (!email) throw new Error(`Nao foi possivel resolver email para user_id=${userId}`);

  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw linkErr;

  const otp = link?.properties?.email_otp;
  if (!otp) throw new Error("Falha ao gerar OTP para validacao API.");

  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "email",
      token: otp,
      email,
    }),
  });
  const verifyJson = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok || !verifyJson?.access_token) {
    throw new Error(`Falha auth verify (${verifyRes.status}): ${JSON.stringify(verifyJson)}`);
  }
  return verifyJson.access_token;
}

async function callApi(routePath, token) {
  const url = `${API_BASE}${routePath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 20000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body, url, timeout: false };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      body: {},
      url,
      timeout: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractDetailFinancial(body) {
  const fb = body?.blocks?.financial_breakdown ?? {};
  const pm = body?.blocks?.profit_margin ?? {};
  return {
    profit_brl: pm?.profit_brl ?? fb?.profit_brl ?? null,
    margin_percent: pm?.margin_percent ?? fb?.margin_percent ?? null,
    product_cost_brl: fb?.product_cost_only_brl ?? fb?.internal_costs?.product_cost_brl ?? null,
    tax_brl: fb?.internal_tax_brl ?? fb?.internal_taxes ?? null,
    operation_packaging_brl: fb?.operation_packaging_cost_brl ?? fb?.operation_packaging_cost ?? null,
  };
}

function extractListFinancial(row) {
  const fin = row?.financials ?? {};
  return {
    profit_brl: fin?.profit_brl ?? row?.profit_brl ?? null,
    margin_percent: fin?.margin_percent ?? row?.margin_percent ?? null,
    product_cost_brl: fin?.product_cost_only_brl ?? row?.product_cost_only_brl ?? null,
    tax_brl: fin?.internal_tax_brl ?? fin?.internal_taxes ?? null,
    operation_packaging_brl: fin?.operation_packaging_cost_brl ?? fin?.operation_packaging_cost ?? null,
  };
}

function extractExecFinancial(body) {
  const s = body?.summary ?? {};
  return {
    profit_brl: s?.net_profit_brl ?? s?.contribution_profit_brl ?? null,
    margin_percent: s?.contribution_margin_percent ?? null,
    product_cost_brl: s?.product_cost_only_brl ?? null,
    tax_brl: s?.tax_cost_brl ?? null,
    operation_packaging_brl: s?.operation_packaging_cost_brl ?? null,
  };
}

function hasKeyFinancialValues(fin) {
  return !isMissingValue(fin?.profit_brl) &&
    !isMissingValue(fin?.margin_percent) &&
    !isMissingValue(fin?.product_cost_brl) &&
    !isMissingValue(fin?.tax_brl) &&
    !isMissingValue(fin?.operation_packaging_brl);
}

async function runEndpointValidationForItem(ctx, tokenCache) {
  const tokenKey = String(ctx.user_id);
  let token = tokenCache.get(tokenKey);
  if (!token) {
    token = await resolveAccessTokenForUser(ctx.user_id);
    tokenCache.set(tokenKey, token);
  }

  const detail = await callApi(`/api/sales/detail?item_id=${encodeURIComponent(ctx.item_id)}`, token);
  const list = await callApi(
    `/api/sales?page=1&page_size=200&q=${encodeURIComponent(ctx.external_order_id ?? "")}`,
    token,
  );
  const exec = await callApi(
    `/api/sales/executive-summary?product_id=${encodeURIComponent(ctx.product_id)}&marketplace_account_id=${encodeURIComponent(ctx.marketplace_account_id ?? "")}&period_preset=60d`,
    token,
  );

  const listRows = Array.isArray(list.body?.rows)
    ? list.body.rows
    : Array.isArray(list.body?.items)
      ? list.body.items
      : [];
  const listRow =
    listRows.find((row) => String(row.item_id ?? row.id ?? "") === String(ctx.item_id)) ?? null;

  const detailFin = extractDetailFinancial(detail.body);
  const listFin = extractListFinancial(listRow);
  const execFin = extractExecFinancial(exec.body);

  const detailPass = detail.status === 200 && hasKeyFinancialValues(detailFin);
  const listPass = list.status === 200 && hasKeyFinancialValues(listFin);
  const execPass = exec.status === 200 && hasKeyFinancialValues(execFin);

  return {
    endpoints: {
      sales_detail: {
        status: detail.status,
        pass: detailPass,
        values: detailFin,
      },
      sales_list: {
        status: list.status,
        pass: listPass,
        values: listFin,
      },
      executive_summary: {
        status: exec.status,
        pass: execPass,
        values: execFin,
      },
    },
    ui_derivatives: {
      product_vendas_desempenho: execPass,
      product_historico_vendas: listPass,
    },
  };
}

async function main() {
  console.log("[S7 BACKFILL] Inicio");
  console.log("[S7 BACKFILL] Modo =", DRY_RUN ? "DRY_RUN" : "EXECUTE");
  console.log("[S7 BACKFILL] API_BASE =", API_BASE);
  console.log("[S7 BACKFILL] LIMIT/OFFSET =", LIMIT, OFFSET);

  let query = sb
    .from("sales_order_items")
    .select(
      "id,user_id,sales_order_id,marketplace,marketplace_account_id,seller_company_id,external_order_id,external_listing_id,quantity,raw_json,updated_at",
    )
    .order("updated_at", { ascending: false })
    .range(OFFSET, OFFSET + LIMIT - 1);
  if (ITEM_ID) {
    query = query.eq("id", ITEM_ID);
  }
  const { data: itemRows, error: itemErr } = await query;
  if (itemErr) throw itemErr;

  const rows = (itemRows ?? []).filter((row) => row && typeof row === "object");
  console.log("[S7 BACKFILL] Itens carregados =", rows.length);

  /** @type {Map<string, Record<string, unknown>>} */
  const orderCache = new Map();
  /** @type {Map<string, Record<string, unknown> | null>} */
  const listingCache = new Map();
  /** @type {Map<string, Record<string, unknown> | null>} */
  const productCache = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const taxProfileCache = new Map();
  /** @type {Map<string, string>} */
  const tokenCache = new Map();

  /** @type {Array<Record<string, unknown>>} */
  const itemReport = [];
  /** @type {Array<Record<string, unknown>>} */
  const validationSamples = [];

  let totalJaCompleto = 0;
  let totalReenriquecido = 0;
  let totalErro = 0;
  let totalSemVinculoProduto = 0;
  let totalSemCustoDisponivel = 0;
  let totalSemImpostoDisponivel = 0;

  for (const rawRow of rows) {
    const row = /** @type {Record<string, unknown>} */ (rawRow);
    const itemId = String(row.id);
    const userId = String(row.user_id);
    const salesOrderId = String(row.sales_order_id);
    const marketplaceAccountId = toTrim(row.marketplace_account_id) || null;
    const listingExternalId = toTrim(row.external_listing_id) || null;
    const nowIso = new Date().toISOString();

    try {
      const rowRawJson = toObj(row.raw_json) ?? {};
      const existingFin = pickFinancial(rowRawJson) ?? {};

      if (isFinancialSnapshotBackfillComplete(existingFin)) {
        totalJaCompleto += 1;
        itemReport.push({
          item_id: itemId,
          pass: true,
          action: "ja_completo",
          changed: false,
          reason: "snapshot_financeiro_completo",
        });
        continue;
      }

      let order = orderCache.get(salesOrderId);
      if (!order) {
        const { data: orderRow, error: orderErr } = await sb
          .from("sales_orders")
          .select("*")
          .eq("id", salesOrderId)
          .maybeSingle();
        if (orderErr) throw orderErr;
        if (!orderRow) throw new Error(`order_not_found:${salesOrderId}`);
        order = orderRow;
        orderCache.set(salesOrderId, orderRow);
      }

      const listingCacheKey = `${userId}::${marketplaceAccountId ?? ""}::${listingExternalId ?? ""}`;
      let listing = listingCache.get(listingCacheKey);
      if (listing === undefined) {
        if (listingExternalId && marketplaceAccountId) {
          const { data: listingRow, error: listingErr } = await sb
            .from("marketplace_listings")
            .select("id,product_id,marketplace_account_id,external_listing_id")
            .eq("user_id", userId)
            .eq("marketplace_account_id", marketplaceAccountId)
            .eq("external_listing_id", listingExternalId)
            .maybeSingle();
          if (listingErr) throw listingErr;
          listing = listingRow ?? null;
        } else {
          listing = null;
        }
        listingCache.set(listingCacheKey, listing);
      }

      const rowRaw = toObj(row.raw_json);
      const productId =
        listing?.product_id != null && isUuidLike(listing.product_id)
          ? String(listing.product_id)
          : rowRaw?.product_id != null && isUuidLike(rowRaw.product_id)
            ? String(rowRaw.product_id)
            : null;

      let product = null;
      if (productId) {
        product = productCache.get(productId);
        if (product === undefined) {
          const { data: productRow, error: productErr } = await sb
            .from("products")
            .select("id,cost_price,packaging_cost,operational_cost")
            .eq("user_id", userId)
            .eq("id", productId)
            .maybeSingle();
          if (productErr) throw productErr;
          product = productRow ?? null;
          productCache.set(productId, product);
        }
      } else {
        totalSemVinculoProduto += 1;
      }

      const sellerCompanyId =
        toTrim(row.seller_company_id) ||
        toTrim(order.seller_company_id) ||
        null;
      const taxCacheKey = `${userId}::${sellerCompanyId ?? ""}::${marketplaceAccountId ?? ""}`;
      let taxProfile = taxProfileCache.get(taxCacheKey);
      if (!taxProfile) {
        taxProfile = await resolveSaleInternalTaxProfile(sb, userId, {
          seller_company_id: sellerCompanyId,
          marketplace_account_id: marketplaceAccountId,
        });
        taxProfileCache.set(taxCacheKey, taxProfile);
      }
      if (isMissingValue(taxProfile?.tax_percent)) totalSemImpostoDisponivel += 1;

      const contract = buildMissingSnapshotsContract({
        item: row,
        order,
        listing,
        product,
        taxProfile,
        existingFin,
        nowIso,
      });

      const hasCostInContract = !isMissingValue(
        toObj(contract.product_cost_snapshot)?.amount_brl,
      );
      if (!hasCostInContract) totalSemCustoDisponivel += 1;

      const merge = fillMissingDeep(existingFin, contract);
      const mergedFinancial = /** @type {Record<string, unknown>} */ (merge.value);
      const changed = Boolean(merge.changed);

      if (changed && !DRY_RUN) {
        const patchedRawJson = {
          ...rowRawJson,
          _s7_financial: mergedFinancial,
        };
        const { error: upErr } = await sb
          .from("sales_order_items")
          .update({
            raw_json: patchedRawJson,
            updated_at: nowIso,
          })
          .eq("id", itemId)
          .eq("user_id", userId);
        if (upErr) throw upErr;
      }

      if (changed) totalReenriquecido += 1;
      else totalJaCompleto += 1;

      let validation = null;
      const eligibleForValidation =
        productId != null &&
        hasCostInContract &&
        !isMissingValue(taxProfile?.tax_percent) &&
        validationSamples.length < VALIDATE_LIMIT;
      if (eligibleForValidation) {
        validation = await runEndpointValidationForItem(
          {
            item_id: itemId,
            user_id: userId,
            external_order_id:
              toTrim(row.external_order_id) || toTrim(order.external_order_id) || null,
            product_id: productId,
            marketplace_account_id: marketplaceAccountId,
          },
          tokenCache,
        );
        validationSamples.push({
          item_id: itemId,
          ...validation,
        });
      }

      itemReport.push({
        item_id: itemId,
        pass: true,
        action: changed ? "reenriquecido" : "sem_alteracao",
        changed,
        product_id: productId,
        snapshot_origin: mergedFinancial.snapshot_origin ?? null,
        snapshot_quality: mergedFinancial.snapshot_quality ?? null,
        estimated: mergedFinancial.estimated ?? null,
        missing_before: {
          internal_costs_snapshot: !toObj(existingFin.internal_costs_snapshot),
          product_cost_snapshot: !toObj(existingFin.product_cost_snapshot),
          tax_snapshot: !toObj(existingFin.tax_snapshot),
          operational_cost_snapshot: !toObj(existingFin.operational_cost_snapshot),
          ads_snapshot: !toObj(existingFin.ads_snapshot),
          profit_snapshot: !toObj(existingFin.profit_snapshot),
          margin_snapshot: !toObj(existingFin.margin_snapshot),
        },
        validation,
      });
    } catch (error) {
      totalErro += 1;
      itemReport.push({
        item_id: itemId,
        pass: false,
        action: "erro",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const totalAuditado = rows.length;
  const endpointStats = {
    sales_detail: { total: 0, pass: 0 },
    sales_list: { total: 0, pass: 0 },
    executive_summary: { total: 0, pass: 0 },
    product_vendas_desempenho: { total: 0, pass: 0 },
    product_historico_vendas: { total: 0, pass: 0 },
  };
  for (const sample of validationSamples) {
    const ep = sample.endpoints ?? {};
    const ui = sample.ui_derivatives ?? {};
    if (ep.sales_detail) {
      endpointStats.sales_detail.total += 1;
      if (ep.sales_detail.pass) endpointStats.sales_detail.pass += 1;
    }
    if (ep.sales_list) {
      endpointStats.sales_list.total += 1;
      if (ep.sales_list.pass) endpointStats.sales_list.pass += 1;
    }
    if (ep.executive_summary) {
      endpointStats.executive_summary.total += 1;
      if (ep.executive_summary.pass) endpointStats.executive_summary.pass += 1;
    }
    if (Object.prototype.hasOwnProperty.call(ui, "product_vendas_desempenho")) {
      endpointStats.product_vendas_desempenho.total += 1;
      if (ui.product_vendas_desempenho) endpointStats.product_vendas_desempenho.pass += 1;
    }
    if (Object.prototype.hasOwnProperty.call(ui, "product_historico_vendas")) {
      endpointStats.product_historico_vendas.total += 1;
      if (ui.product_historico_vendas) endpointStats.product_historico_vendas.pass += 1;
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: DRY_RUN ? "dry_run" : "execute",
    dev_confirmed: CONFIRM_DEV,
    api_base: API_BASE,
    parameters: {
      limit: LIMIT,
      offset: OFFSET,
      item_id: ITEM_ID,
      validate_limit: VALIDATE_LIMIT,
    },
    summary: {
      total_auditado: totalAuditado,
      total_reenriquecido: totalReenriquecido,
      total_ja_completo: totalJaCompleto,
      total_com_erro: totalErro,
      total_sem_vinculo_produto: totalSemVinculoProduto,
      total_sem_custo_disponivel: totalSemCustoDisponivel,
      total_sem_imposto_disponivel: totalSemImpostoDisponivel,
    },
    endpoint_validation_summary: endpointStats,
    items: itemReport,
    validation_samples: validationSamples,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2), "utf8");

  console.log("\n[S7 BACKFILL] SUMMARY");
  console.table([
    { indicador: "total_auditado", valor: report.summary.total_auditado },
    { indicador: "total_reenriquecido", valor: report.summary.total_reenriquecido },
    { indicador: "total_ja_completo", valor: report.summary.total_ja_completo },
    { indicador: "total_com_erro", valor: report.summary.total_com_erro },
    { indicador: "total_sem_vinculo_produto", valor: report.summary.total_sem_vinculo_produto },
    { indicador: "total_sem_custo_disponivel", valor: report.summary.total_sem_custo_disponivel },
    { indicador: "total_sem_imposto_disponivel", valor: report.summary.total_sem_imposto_disponivel },
  ]);
  console.log("[S7 BACKFILL] Report JSON:", OUTPUT_FILE);

  if (report.summary.total_com_erro > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error("[S7 BACKFILL] fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

