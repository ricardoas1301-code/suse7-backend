#!/usr/bin/env node
/**
 * Homologação SSOT — listagem Produtos vs Raio-X / Vendas / Executive Summary.
 * Uso: node scripts/homologar_produtos_catalog_ssot.mjs [--product-id <uuid>] [--api-base http://localhost:3001]
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const parentDir = path.resolve(scriptDir, "..");
const backendRoot =
  path.basename(scriptDir) === "scripts" && fsSync.existsSync(path.join(parentDir, "package.json"))
    ? parentDir
    : path.resolve(parentDir, "suse7-backend");
const root = path.resolve(backendRoot, "..");

dotenv.config({ path: path.join(backendRoot, ".env.vercel") });
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] != null ? String(argv[i + 1]) : fallback;
};

const API_BASE = String(arg("--api-base", process.env.S7_API_BASE || "http://localhost:3001")).replace(/\/+$/, "");
const FORCED_PRODUCT_ID = arg("--product-id", null);
const OUTPUT = arg(
  "--output",
  path.join(root, "scripts", "output", `homolog_produtos_catalog_ssot_${Date.now()}.json`),
);

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios (suse7-backend/.env.local).");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function toMoney(v) {
  if (v == null || v === "") return null;
  try {
    return new Decimal(String(v).replace(",", ".")).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    return null;
  }
}

function moneyEq(a, b) {
  return toMoney(a) === toMoney(b);
}

function pctEq(a, b) {
  const aa = a == null ? null : toMoney(a);
  const bb = b == null ? null : toMoney(b);
  return aa === bb;
}

function intEq(a, b) {
  return Math.trunc(Number(a) || 0) === Math.trunc(Number(b) || 0);
}

async function resolveAccessTokenForUser(userId) {
  const { data: userRes, error } = await sb.auth.admin.getUserById(String(userId));
  if (error) throw error;
  const email = userRes?.user?.email;
  if (!email) throw new Error(`email não encontrado user_id=${userId}`);

  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw linkErr;

  const otp = link?.properties?.email_otp;
  if (!otp) throw new Error("OTP não gerado");

  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "email", token: otp, email }),
  });
  const verifyJson = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok || !verifyJson?.access_token) {
    throw new Error(`verify falhou: ${verifyRes.status} ${JSON.stringify(verifyJson).slice(0, 200)}`);
  }
  return verifyJson.access_token;
}

async function apiGet(token, pathname, qs = "") {
  const url = `${API_BASE}${pathname}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, ok: res.ok, json, url };
}

function extractProductMetrics(label, payload) {
  if (!payload) return { label, error: "payload vazio" };

  if (label === "catalog_financial") {
    const row = payload;
    return {
      label,
      vendas: row.quantity_sold ?? 0,
      faturamento: toMoney(row.gross_sales_brl),
      ticket_medio: toMoney(row.average_ticket_brl),
      lucro_brl: toMoney(row.contribution_profit_brl),
      lucro_pct: toMoney(row.contribution_margin_percent),
      ads_count: null,
    };
  }

  if (label === "executive_summary_product" || label === "vendas_product_scope") {
    const s = payload.summary ?? payload;
    return {
      label,
      vendas: s.items_quantity_sold ?? s.orders_count ?? 0,
      faturamento: toMoney(s.gross_sales_brl),
      ticket_medio: toMoney(s.average_ticket_brl),
      lucro_brl: toMoney(s.contribution_profit_brl ?? s.net_profit_brl),
      lucro_pct: toMoney(s.contribution_margin_percent),
      ads_count: payload.filters_applied?.linked_listings_count ?? null,
    };
  }

  if (label === "executive_summary_global_product_rank") {
    return {
      label,
      vendas: payload.quantity_sold ?? 0,
      faturamento: toMoney(payload.gross_sales_brl),
      ticket_medio: toMoney(payload.average_ticket_brl),
      lucro_brl: toMoney(payload.contribution_profit_brl ?? payload.profit_brl),
      lucro_pct: toMoney(payload.contribution_margin_percent ?? payload.margin_percent),
      ads_count: payload.linked_listings_count ?? null,
    };
  }

  if (label === "anuncios_listings_sum") {
    return {
      label,
      vendas: payload.vendas,
      faturamento: toMoney(payload.faturamento),
      ticket_medio: toMoney(payload.ticket_medio),
      lucro_brl: toMoney(payload.lucro_brl),
      lucro_pct: toMoney(payload.lucro_pct),
      ads_count: payload.ads_count,
      listings_counted: payload.listings_counted,
    };
  }

  return { label, error: "label desconhecido" };
}

function sumListingsFromRankings(rankings) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byKey = new Map();
  const lists = [
    rankings?.listings,
    rankings?.listings_by_quantity,
    rankings?.listings_by_gross_revenue,
    rankings?.listings_by_net_profit,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const ext = row?.external_listing_id ?? row?.listing_id ?? "";
      const mkt = row?.marketplace ?? "mkt";
      const key = `${mkt}::${ext}`;
      if (!String(ext).trim()) continue;
      const prev = byKey.get(key) ?? {};
      byKey.set(key, { ...prev, ...row });
    }
  }

  let qty = 0;
  let gross = new Decimal(0);
  let profit = new Decimal(0);
  for (const row of byKey.values()) {
    const q = Math.trunc(Number(row.quantity_sold) || 0);
    qty += q;
    try {
      gross = gross.plus(new Decimal(String(row.gross_sales_brl ?? "0").replace(",", ".")));
    } catch {
      /* ignore */
    }
    try {
      profit = profit.plus(
        new Decimal(String(row.contribution_profit_brl ?? row.profit_brl ?? "0").replace(",", ".")),
      );
    } catch {
      /* ignore */
    }
  }

  const ticket =
    qty > 0 ? gross.div(qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;
  const margin = !gross.isZero()
    ? profit.div(gross).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
    : null;

  return {
    vendas: qty,
    faturamento: gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    ticket_medio: ticket,
    lucro_brl: profit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    lucro_pct: margin,
    listings_counted: byKey.size,
  };
}

function compareMetrics(reference, others) {
  const fields = ["vendas", "faturamento", "ticket_medio", "lucro_brl", "lucro_pct"];
  /** @type {Record<string, unknown>} */
  const report = { reference: reference.label, matches: {}, mismatches: {}, skipped: {} };

  for (const field of fields) {
    const refVal = reference[field];
    const mismatches = [];
    for (const o of others) {
      if (o.error || o[field] == null) {
        if (!report.skipped[o.label]) report.skipped[o.label] = o.error ?? "métrica ausente";
        continue;
      }
      let ok = false;
      if (field === "vendas") ok = intEq(refVal, o[field]);
      else if (field === "lucro_pct" || field === "faturamento" || field === "ticket_medio" || field === "lucro_brl") {
        ok = pctEq(refVal, o[field]) || toMoney(refVal) === toMoney(o[field]);
      }
      if (!ok) mismatches.push({ source: o.label, expected: refVal, actual: o[field] });
    }
    if (mismatches.length === 0) report.matches[field] = refVal;
    else report.mismatches[field] = mismatches;
  }

  report.pass = Object.keys(report.mismatches).length === 0;
  return report;
}

async function pickCandidateProduct() {
  const { data: listings, error } = await sb
    .from("marketplace_listings")
    .select("product_id,user_id")
    .not("product_id", "is", null);
  if (error) throw error;

  /** @type {Record<string, { ads: number; userId: string }>} */
  const byProduct = {};
  for (const row of listings ?? []) {
    const pid = String(row.product_id).trim();
    const uid = String(row.user_id).trim();
    if (!pid || !uid) continue;
    const prev = byProduct[pid] ?? { ads: 0, userId: uid };
    byProduct[pid] = { ads: prev.ads + 1, userId: uid };
  }

  const multi = Object.entries(byProduct)
    .filter(([, meta]) => meta.ads >= 2)
    .map(([pid, meta]) => ({ pid, ads: meta.ads, userId: meta.userId }))
    .sort((a, b) => b.ads - a.ads);

  if (multi.length === 0) return null;

  /** @type {Map<string, typeof multi>} */
  const byUser = new Map();
  for (const row of multi) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }

  for (const [userId, candidates] of byUser) {
    const token = await resolveAccessTokenForUser(userId);
    const catalog = await apiGet(token, "/api/products/catalog-financial");
    if (!catalog.ok || catalog.json?.ok !== true) continue;

    const byId = catalog.json.by_product_id ?? {};
    const scored = candidates
      .map(({ pid, ads }) => {
        const fin = byId[pid];
        const qty = Number(fin?.quantity_sold) || 0;
        const gross = toMoney(fin?.gross_sales_brl) ?? "0.00";
        return { pid, ads, qty, gross: Number(gross), userId };
      })
      .filter((x) => x.qty > 0 && x.gross > 0)
      .sort((a, b) => b.ads - a.ads || b.qty - a.qty);

    if (scored[0]) return scored[0];
  }

  return null;
}

async function main() {
  console.log("[S7][homolog-produtos] API", API_BASE);

  let productId = FORCED_PRODUCT_ID;
  let candidateMeta = null;
  let userId = null;

  if (!productId) {
    candidateMeta = await pickCandidateProduct();
    if (!candidateMeta) {
      console.error("Nenhum produto com ≥2 anúncios e vendas SSOT encontrado.");
      process.exit(1);
    }
    productId = candidateMeta.pid;
    userId = candidateMeta.userId;
  }

  const { data: productRow, error: pErr } = await sb
    .from("products")
    .select("id,user_id,product_name,sku")
    .eq("id", productId)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!productRow) {
    console.error("Produto não encontrado:", productId);
    process.exit(1);
  }
  userId = userId ?? productRow.user_id;

  const token = await resolveAccessTokenForUser(userId);

  const [catalogRes, execProductRes, execGlobalRes, listingsRes] = await Promise.all([
    apiGet(token, "/api/products/catalog-financial"),
    apiGet(token, "/api/sales/executive-summary", `product_id=${encodeURIComponent(productId)}`),
    apiGet(token, "/api/sales/executive-summary", "period_preset=lifetime&product_ranking_limit=10000"),
    apiGet(token, "/api/products/listings", `product_id=${encodeURIComponent(productId)}`),
  ]);

  const catalogRow = catalogRes.json?.by_product_id?.[productId] ?? null;
  const adsDb = catalogRes.json?.ads_linked_count_by_product_id?.[productId] ?? null;
  const listingsCount = Array.isArray(listingsRes.json?.data?.listings)
    ? listingsRes.json.data.listings.length
    : Array.isArray(listingsRes.json?.listings)
      ? listingsRes.json.listings.length
      : null;

  const globalProductRank = (execGlobalRes.json?.rankings?.products ?? []).find(
    (p) => String(p.product_id) === String(productId),
  );

  const anunciosSum = sumListingsFromRankings(execProductRes.json?.rankings);

  const metrics = [
    extractProductMetrics("catalog_financial", catalogRow),
    extractProductMetrics("executive_summary_product", execProductRes.json),
    extractProductMetrics("vendas_product_scope", execProductRes.json),
    extractProductMetrics("executive_summary_global_product_rank", globalProductRank),
    extractProductMetrics("anuncios_listings_sum", {
      ...anunciosSum,
      ads_count: adsDb ?? listingsCount,
    }),
  ];

  for (const m of metrics) {
    if (m.label === "catalog_financial") m.ads_count = adsDb;
    if (m.label === "executive_summary_product")
      m.ads_count = execProductRes.json?.filters_applied?.linked_listings_count ?? adsDb;
  }

  const reference = metrics.find((m) => m.label === "catalog_financial");
  const others = metrics.filter((m) => m.label !== "catalog_financial" && m.label !== "vendas_product_scope");
  const comparison = compareMetrics(reference, others.filter((m) => m.label !== "vendas_product_scope"));

  const anunciosVsProduct = compareMetrics(
    extractProductMetrics("executive_summary_product", execProductRes.json),
    [extractProductMetrics("anuncios_listings_sum", { ...anunciosSum, ads_count: adsDb })],
  );

  const result = {
    homologated_at: new Date().toISOString(),
    status: comparison.pass && anunciosVsProduct.pass ? "APROVADO" : "REPROVADO",
    product_id: productId,
    product_name: productRow?.product_name ?? null,
    sku: productRow?.sku ?? null,
    user_id: userId,
    candidate: candidateMeta,
    ads_linked_count_db: adsDb,
    listings_api_count: listingsCount,
    metrics,
    comparison_catalog_vs_sources: comparison,
    comparison_rayx_anuncios_sum_vs_product: anunciosVsProduct,
    notes: [
      "catalog_financial = Produtos > Lista",
      "executive_summary_product = Raio-X Vendas & Desempenho + Vendas filtrada (product_id, lifetime)",
      "anuncios_listings_sum = soma rankings listings do executive-summary product scope",
      "executive_summary_global_product_rank = entrada em rankings.products (executive-summary lifetime, sem product_id)",
    ],
    api_urls: {
      catalog: catalogRes.url,
      executive_product: execProductRes.url,
      executive_global: execGlobalRes.url,
      listings: listingsRes.url,
    },
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(result, null, 2), "utf8");

  console.log("\n=== HOMOLOGAÇÃO PRODUTOS SSOT ===");
  console.log("Status:", result.status);
  console.log("Product ID:", productId);
  console.log("Nome:", result.product_name);
  console.log("SKU:", result.sku);
  console.log("Anúncios (DB):", adsDb);
  console.log("\nMétricas por fonte:");
  for (const m of metrics) {
    console.log(`  [${m.label}]`, JSON.stringify(m));
  }
  console.log("\nComparação (ref=catalog_financial):", JSON.stringify(comparison, null, 2));
  console.log("\nAnúncios sum vs product:", JSON.stringify(anunciosVsProduct, null, 2));
  console.log("\nEvidência JSON:", OUTPUT);

  process.exit(result.status === "APROVADO" ? 0 : 1);
}

main().catch((err) => {
  console.error("[S7][homolog-produtos] FAIL", err?.message ?? err);
  process.exit(1);
});
