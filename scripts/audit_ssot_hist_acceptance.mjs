#!/usr/bin/env node
/**
 * MISSAO CRITICA S7-HIST-001..004
 * Auditoria SQL/API de aceite para SSOT financeiro:
 * - onboarding_import (reconstructed)
 * - post_suse7_sale (historical)
 * - consistencia entre /api/sales/detail, /api/sales, /api/sales/executive-summary
 * - imutabilidade apos mudanca temporaria de configuracao atual (com restore)
 *
 * Uso:
 *   node scripts/audit_ssot_hist_acceptance.mjs
 *   node scripts/audit_ssot_hist_acceptance.mjs --onboarding-item <uuid> --post-item <uuid>
 *   node scripts/audit_ssot_hist_acceptance.mjs --skip-mutation
 *   node scripts/audit_ssot_hist_acceptance.mjs --api-base http://localhost:3001
 */

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import Decimal from "decimal.js";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1] != null ? String(argv[i + 1]) : fallback;
};
const hasFlag = (name) => argv.includes(name);

const API_BASE = String(arg("--api-base", process.env.S7_API_BASE || "http://localhost:3001")).replace(/\/+$/, "");
const SKIP_MUTATION = hasFlag("--skip-mutation");
const OUTPUT_FILE = arg("--output", path.join("scripts", "output", `audit_ssot_hist_acceptance_${Date.now()}.json`));

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Env obrigatoria ausente: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MONEY_FIELDS = [
  "preco_vendido",
  "tarifa_marketplace",
  "frete",
  "valor_recebido",
  "custo_produto",
  "imposto",
  "custos_operacionais",
  "lucro",
  "margem",
];

function toMoney(v) {
  if (v == null || v === "") return null;
  try {
    return new Decimal(String(v)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    return null;
  }
}

function moneyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return toMoney(a) === toMoney(b);
}

function textEqual(a, b) {
  const aa = a == null ? null : String(a);
  const bb = b == null ? null : String(b);
  return aa === bb;
}

function unwrapFinancial(rawJson) {
  if (!rawJson || typeof rawJson !== "object") return null;
  const fin = rawJson._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
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
  if (!otp) throw new Error("Falha ao gerar OTP para autenticacao API.");

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

async function pickItemBySnapshotOrigin(origin) {
  const { data, error } = await sb
    .from("sales_order_items")
    .select("id,user_id,raw_json,updated_at")
    .order("updated_at", { ascending: false })
    .limit(1200);
  if (error) throw error;
  for (const row of data ?? []) {
    const fin = unwrapFinancial(row.raw_json);
    if (!fin) continue;
    if (String(fin.snapshot_origin ?? "").trim().toLowerCase() === String(origin).trim().toLowerCase()) {
      return row;
    }
  }
  return null;
}

/**
 * @param {(fin: Record<string, unknown>) => boolean} predicate
 */
async function pickItemByFinancialPredicate(predicate) {
  const { data, error } = await sb
    .from("sales_order_items")
    .select("id,user_id,raw_json,updated_at")
    .order("updated_at", { ascending: false })
    .limit(1200);
  if (error) throw error;
  for (const row of data ?? []) {
    const fin = unwrapFinancial(row.raw_json);
    if (!fin) continue;
    if (predicate(fin)) return row;
  }
  return null;
}

async function fetchSaleContext(itemId) {
  const { data: item, error: itemErr } = await sb
    .from("sales_order_items")
    .select("*")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) throw itemErr;
  if (!item) throw new Error(`Item nao encontrado: ${itemId}`);

  const { data: order, error: orderErr } = await sb
    .from("sales_orders")
    .select("*")
    .eq("id", item.sales_order_id)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) throw new Error(`Pedido nao encontrado para item=${itemId}`);

  return { item, order };
}

async function callApi(routePath, token) {
  const url = `${API_BASE}${routePath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body, url };
}

function extractFromDetail(payload) {
  const fb = payload?.blocks?.financial_breakdown ?? {};
  const mr = fb?.marketplace_revenue ?? {};
  const pm = payload?.blocks?.profit_margin ?? {};
  const ics = fb?.internal_costs_snapshot ?? {};
  const productRaw = payload?.blocks?.product?.raw_json;
  const finRaw =
    productRaw && typeof productRaw === "object" && productRaw._s7_financial && typeof productRaw._s7_financial === "object"
      ? productRaw._s7_financial
      : null;
  const origin =
    fb?.snapshot_origin ?? mr?.snapshot_origin ?? finRaw?.snapshot_origin ?? ics?.snapshot_origin ?? null;

  return {
    preco_vendido: mr?.gross_sale_amount_brl ?? fb?.gross_amount ?? fb?.sale_price ?? null,
    tarifa_marketplace: mr?.marketplace_fee_amount_brl ?? fb?.marketplace_fee_amount ?? fb?.commission ?? null,
    frete: mr?.shipping_amount_brl ?? fb?.shipping_cost_amount ?? fb?.shipping_cost ?? null,
    valor_recebido: mr?.net_received_amount_brl ?? fb?.net_received_amount ?? fb?.net_received ?? null,
    custo_produto: fb?.product_cost_only_brl ?? fb?.internal_costs?.product_cost_brl ?? null,
    imposto: fb?.internal_tax_brl ?? fb?.internal_taxes ?? fb?.internal_tax_amount ?? null,
    custos_operacionais:
      fb?.operation_packaging_cost_brl ?? fb?.operational_costs_brl ?? fb?.operation_packaging_cost ?? null,
    lucro: pm?.profit_brl ?? fb?.profit_brl ?? fb?.profit_amount ?? null,
    margem: pm?.margin_percent ?? fb?.margin_percent ?? null,
    saude: pm?.health_status ?? pm?.health ?? fb?.health_status ?? fb?.health ?? null,
    snapshot_origin: origin,
    snapshot_quality: fb?.snapshot_quality ?? finRaw?.snapshot_quality ?? ics?.snapshot_quality ?? null,
    estimated:
      typeof fb?.estimated === "boolean"
        ? fb.estimated
        : typeof finRaw?.estimated === "boolean"
          ? finRaw.estimated
          : typeof ics?.estimated === "boolean"
            ? ics.estimated
            : null,
  };
}

function extractFromListItem(row) {
  const fin = row?.financials ?? {};
  const mr = fin?.marketplace_revenue ?? {};
  const ics = fin?.internal_costs_snapshot ?? {};
  const rowRaw = row?.raw_json;
  const finRaw =
    rowRaw && typeof rowRaw === "object" && rowRaw._s7_financial && typeof rowRaw._s7_financial === "object"
      ? rowRaw._s7_financial
      : null;
  const origin =
    fin?.snapshot_origin ?? mr?.snapshot_origin ?? finRaw?.snapshot_origin ?? ics?.snapshot_origin ?? null;

  return {
    preco_vendido: mr?.gross_sale_amount_brl ?? fin?.gross_amount ?? row?.gross_amount ?? null,
    tarifa_marketplace: mr?.marketplace_fee_amount_brl ?? fin?.marketplace_fee_amount ?? row?.fee_amount ?? null,
    frete: mr?.shipping_amount_brl ?? fin?.shipping_cost_amount ?? row?.shipping_share_amount ?? null,
    valor_recebido: mr?.net_received_amount_brl ?? fin?.net_received_amount ?? row?.net_amount ?? null,
    custo_produto: fin?.product_cost_only_brl ?? row?.product_cost_only_brl ?? null,
    imposto: fin?.internal_tax_brl ?? fin?.internal_taxes ?? fin?.internal_tax_amount ?? null,
    custos_operacionais:
      fin?.operation_packaging_cost_brl ?? fin?.operational_costs_brl ?? fin?.operation_packaging_cost ?? null,
    lucro: fin?.profit_brl ?? row?.profit_brl ?? null,
    margem: fin?.margin_percent ?? row?.margin_percent ?? null,
    saude: fin?.health_status ?? fin?.health ?? row?.health_status ?? row?.health ?? null,
    snapshot_origin: origin,
    snapshot_quality: fin?.snapshot_quality ?? finRaw?.snapshot_quality ?? ics?.snapshot_quality ?? null,
    estimated:
      typeof fin?.estimated === "boolean"
        ? fin.estimated
        : typeof finRaw?.estimated === "boolean"
          ? finRaw.estimated
          : typeof ics?.estimated === "boolean"
            ? ics.estimated
            : null,
  };
}

function extractFromExecutiveSummary(payload) {
  const s = payload?.summary ?? {};
  return {
    preco_vendido: s?.gross_sales_brl ?? null,
    tarifa_marketplace: s?.marketplace_fee_brl ?? null,
    frete: s?.shipping_cost_brl ?? null,
    valor_recebido: s?.net_received_brl ?? null,
    custo_produto: s?.product_cost_only_brl ?? null,
    imposto: s?.tax_cost_brl ?? null,
    custos_operacionais: s?.operational_costs_brl ?? null,
    lucro: s?.net_profit_brl ?? s?.contribution_profit_brl ?? null,
    margem: s?.contribution_margin_percent ?? null,
    saude: s?.health_status ?? null,
    snapshot_origin: s?.snapshot_origin ?? null,
    snapshot_quality: s?.snapshot_quality ?? null,
    estimated: typeof s?.estimated === "boolean" ? s.estimated : null,
  };
}

function compareFieldMap(
  ref,
  other,
  label,
  fields = [...MONEY_FIELDS, "saude", "snapshot_origin", "snapshot_quality", "estimated"],
  options = {},
) {
  const allowNullRefAsWildcard = options.allowNullRefAsWildcard === true;
  /** @type {Array<{field: string, pass: boolean, ref: unknown, got: unknown}>} */
  const out = [];
  for (const key of fields) {
    const a = ref[key];
    const b = other[key];
    if (allowNullRefAsWildcard && a == null) {
      out.push({ field: key, pass: true, ref: a, got: b });
      continue;
    }
    const pass =
      MONEY_FIELDS.includes(key) ? moneyEqual(a, b) : key === "estimated" ? a === b : textEqual(a, b);
    out.push({ field: key, pass, ref: a, got: b });
  }
  return { label, checks: out, pass: out.every((x) => x.pass) };
}

async function tryTemporaryMutation(context) {
  const restoreStack = [];
  const mutations = [];

  const safeTrack = async (table, idValue, originalRow, patch) => {
    restoreStack.push({ table, idValue, originalRow });
    const { error } = await sb.from(table).update(patch).eq("id", idValue);
    if (error) throw error;
    mutations.push({ table, id: idValue, patch });
  };

  try {
    const productId =
      context.item?.product_id != null && String(context.item.product_id).trim() !== ""
        ? String(context.item.product_id)
        : null;
    if (productId) {
      const { data: product, error: pErr } = await sb.from("products").select("*").eq("id", productId).maybeSingle();
      if (!pErr && product) {
        for (const col of [
          "cost",
          "cost_brl",
          "cost_price",
          "purchase_cost",
          "custo",
          "product_cost",
          "product_cost_brl",
        ]) {
          if (product[col] == null) continue;
          const next = toMoney(new Decimal(String(product[col])).plus("11.11"));
          if (next != null) {
            await safeTrack("products", productId, product, { [col]: next });
            break;
          }
        }
      }
    }

    const sellerCompanyId =
      context.order?.seller_company_id != null && String(context.order.seller_company_id).trim() !== ""
        ? String(context.order.seller_company_id)
        : null;
    if (sellerCompanyId) {
      const { data: company, error: cErr } = await sb
        .from("seller_companies")
        .select("*")
        .eq("id", sellerCompanyId)
        .maybeSingle();
      if (!cErr && company) {
        for (const col of [
          "tax_percent",
          "tax_rate",
          "internal_tax_percent",
          "aliquota_imposto",
          "simples_nacional_percent",
        ]) {
          if (company[col] == null) continue;
          const next = toMoney(new Decimal(String(company[col])).plus("1.00"));
          if (next != null) {
            await safeTrack("seller_companies", sellerCompanyId, company, { [col]: next });
            break;
          }
        }
      }
    }

    return { applied: true, mutations, restoreStack };
  } catch (error) {
    return { applied: false, mutations, restoreStack, error: error instanceof Error ? error.message : String(error) };
  }
}

async function restoreMutations(restoreStack) {
  const results = [];
  for (let i = restoreStack.length - 1; i >= 0; i -= 1) {
    const r = restoreStack[i];
    const { error } = await sb.from(r.table).update(r.originalRow).eq("id", r.idValue);
    results.push({
      table: r.table,
      id: r.idValue,
      restored: !error,
      error: error?.message ?? null,
    });
  }
  return results;
}

function checkMandatorySnapshotMetadata(fin, expected) {
  const checks = [
    { field: "snapshot_origin", pass: textEqual(fin?.snapshot_origin, expected.snapshot_origin), got: fin?.snapshot_origin },
    { field: "snapshot_quality", pass: textEqual(fin?.snapshot_quality, expected.snapshot_quality), got: fin?.snapshot_quality },
    { field: "estimated", pass: fin?.estimated === expected.estimated, got: fin?.estimated },
    { field: "immutable_since", pass: fin?.immutable_since != null && String(fin.immutable_since).trim() !== "", got: fin?.immutable_since },
  ];

  if (expected.snapshot_origin === "onboarding_import") {
    checks.push({
      field: "reconstructed_at",
      pass: fin?.reconstructed_at != null && String(fin.reconstructed_at).trim() !== "",
      got: fin?.reconstructed_at,
    });
    checks.push({
      field: "reconstruction_reference_date",
      pass: fin?.reconstruction_reference_date != null && String(fin.reconstruction_reference_date).trim() !== "",
      got: fin?.reconstruction_reference_date,
    });
  } else {
    checks.push({
      field: "snapshot_created_at",
      pass: fin?.snapshot_created_at != null && String(fin.snapshot_created_at).trim() !== "",
      got: fin?.snapshot_created_at,
    });
  }

  return { checks, pass: checks.every((c) => c.pass) };
}

function checkImmutability(beforeFin, afterFin) {
  const keys = [
    "gross_sale_amount_brl",
    "marketplace_fee_amount_brl",
    "shipping_amount_brl",
    "net_received_amount_brl",
    "product_cost_only_brl",
    "internal_tax_brl",
    "operation_packaging_cost_brl",
    "profit_brl",
    "margin_percent",
    "health",
    "health_status",
    "snapshot_origin",
    "snapshot_quality",
    "estimated",
  ];
  const checks = keys.map((k) => {
    const a = beforeFin?.[k] ?? null;
    const b = afterFin?.[k] ?? null;
    const pass = MONEY_FIELDS.includes(k) ? moneyEqual(a, b) : String(a) === String(b);
    return { field: k, pass, before: a, after: b };
  });
  return { checks, pass: checks.every((c) => c.pass) };
}

async function auditSaleCase({ label, itemId, expectedSnapshot }) {
  const ctx = await fetchSaleContext(itemId);
  const finSqlBefore = unwrapFinancial(ctx.item.raw_json);
  if (!finSqlBefore) {
    throw new Error(`[${label}] item sem raw_json._s7_financial`);
  }

  const metadataCheck = checkMandatorySnapshotMetadata(finSqlBefore, expectedSnapshot);
  const token = await resolveAccessTokenForUser(ctx.item.user_id);
  const orderStartIso =
    ctx.order?.date_created_marketplace != null
      ? new Date(String(ctx.order.date_created_marketplace)).toISOString()
      : ctx.order?.paid_at != null
        ? new Date(String(ctx.order.paid_at)).toISOString()
        : ctx.order?.created_at != null
          ? new Date(String(ctx.order.created_at)).toISOString()
          : null;
  const orderEndIso =
    ctx.order?.date_closed_marketplace != null
      ? new Date(String(ctx.order.date_closed_marketplace)).toISOString()
      : ctx.order?.paid_at != null
        ? new Date(String(ctx.order.paid_at)).toISOString()
        : orderStartIso;
  const marketplace = ctx.item?.marketplace != null ? String(ctx.item.marketplace) : "mercado_livre";
  const marketplaceAccountId =
    ctx.item?.marketplace_account_id != null && String(ctx.item.marketplace_account_id).trim() !== ""
      ? String(ctx.item.marketplace_account_id).trim()
      : ctx.order?.marketplace_account_id != null && String(ctx.order.marketplace_account_id).trim() !== ""
        ? String(ctx.order.marketplace_account_id).trim()
        : null;
  const executivePeriodQuery =
    orderStartIso != null && orderEndIso != null
      ? `start_datetime=${encodeURIComponent(orderStartIso)}&end_datetime=${encodeURIComponent(orderEndIso)}`
      : "period_preset=60d";
  const executiveScopeQuery =
    `marketplace=${encodeURIComponent(marketplace)}` +
    (marketplaceAccountId ? `&marketplace_account_id=${encodeURIComponent(marketplaceAccountId)}` : "");

  const listBefore = await callApi(`/api/sales?page=1&page_size=200&q=${encodeURIComponent(ctx.order.external_order_id)}`, token);
  const detailBefore = await callApi(`/api/sales/detail?item_id=${encodeURIComponent(itemId)}`, token);
  const execBefore = await callApi(
    `/api/sales/executive-summary?${executiveScopeQuery}&${executivePeriodQuery}`,
    token,
  );

  const listRows = Array.isArray(listBefore.body?.rows)
    ? listBefore.body.rows
    : Array.isArray(listBefore.body?.items)
      ? listBefore.body.items
      : [];
  const listRow = listRows.find((r) => String(r.item_id ?? r.id ?? "") === String(itemId)) ?? listRows[0] ?? null;

  const detailMapBefore = extractFromDetail(detailBefore.body);
  const listMapBefore = extractFromListItem(listRow);
  const execMapBefore = extractFromExecutiveSummary(execBefore.body);

  const consistencyBefore = {
    detail_vs_list: compareFieldMap(detailMapBefore, listMapBefore, "detail_vs_list"),
    detail_vs_executive: compareFieldMap(
      detailMapBefore,
      execMapBefore,
      "detail_vs_executive",
      [...MONEY_FIELDS],
      { allowNullRefAsWildcard: true },
    ),
  };

  let mutation = { attempted: false, skipped: SKIP_MUTATION, applied: false, mutations: [], restore_results: [] };
  let immutability = { pass: SKIP_MUTATION, skipped: SKIP_MUTATION, checks: [] };

  if (!SKIP_MUTATION) {
    mutation.attempted = true;
    const mutRes = await tryTemporaryMutation(ctx);
    mutation.applied = mutRes.applied;
    mutation.mutations = mutRes.mutations ?? [];
    mutation.error = mutRes.error ?? null;

    try {
      const ctxAfter = await fetchSaleContext(itemId);
      const finSqlAfter = unwrapFinancial(ctxAfter.item.raw_json);

      const listAfter = await callApi(`/api/sales?page=1&page_size=200&q=${encodeURIComponent(ctx.order.external_order_id)}`, token);
      const detailAfter = await callApi(`/api/sales/detail?item_id=${encodeURIComponent(itemId)}`, token);
      const execAfter = await callApi(
        `/api/sales/executive-summary?${executiveScopeQuery}&${executivePeriodQuery}`,
        token,
      );

      const listRowsAfter = Array.isArray(listAfter.body?.rows)
        ? listAfter.body.rows
        : Array.isArray(listAfter.body?.items)
          ? listAfter.body.items
          : [];
      const listRowAfter =
        listRowsAfter.find((r) => String(r.item_id ?? r.id ?? "") === String(itemId)) ?? listRowsAfter[0] ?? null;

      const detailMapAfter = extractFromDetail(detailAfter.body);
      const listMapAfter = extractFromListItem(listRowAfter);
      const execMapAfter = extractFromExecutiveSummary(execAfter.body);

      const finApiBefore = {
        ...detailMapBefore,
        ...listMapBefore,
        ...execMapBefore,
      };
      const finApiAfter = {
        ...detailMapAfter,
        ...listMapAfter,
        ...execMapAfter,
      };
      immutability = checkImmutability(
        {
          ...finSqlBefore,
          ...finApiBefore,
        },
        {
          ...(finSqlAfter ?? {}),
          ...finApiAfter,
        },
      );
      immutability.skipped = false;
    } finally {
      mutation.restore_results = await restoreMutations(mutRes.restoreStack ?? []);
    }
  }

  const apiHttpOk =
    listBefore.status === 200 && detailBefore.status === 200 && execBefore.status === 200;

  const pass =
    metadataCheck.pass &&
    apiHttpOk &&
    consistencyBefore.detail_vs_list.pass &&
    consistencyBefore.detail_vs_executive.pass &&
    immutability.pass;

  return {
    label,
    item_id: itemId,
    order_id: ctx.order.id,
    external_order_id: ctx.order.external_order_id ?? null,
    expected_snapshot: expectedSnapshot,
    metadata_check: metadataCheck,
    api_http: {
      list_status: listBefore.status,
      detail_status: detailBefore.status,
      executive_status: execBefore.status,
      ok: apiHttpOk,
    },
    api_values_before: {
      detail: detailMapBefore,
      list: listMapBefore,
      executive: execMapBefore,
    },
    consistency_before: consistencyBefore,
    mutation,
    immutability,
    pass,
  };
}

async function resolveTargetItems() {
  const onboardingArg = arg("--onboarding-item", null);
  const postArg = arg("--post-item", null);

  let onboardingItemId = onboardingArg;
  let postItemId = postArg;

  if (!onboardingItemId) {
    const pick = await pickItemBySnapshotOrigin("onboarding_import");
    onboardingItemId = pick?.id ?? null;
  }
  if (!onboardingItemId) {
    const pick = await pickItemByFinancialPredicate((fin) => {
      const quality = String(fin.snapshot_quality ?? "").trim().toLowerCase();
      return quality === "reconstructed" || fin.estimated === true;
    });
    onboardingItemId = pick?.id ?? null;
  }
  if (!postItemId) {
    const pick = await pickItemBySnapshotOrigin("post_suse7_sale");
    postItemId = pick?.id ?? null;
  }
  if (!postItemId) {
    const pick = await pickItemByFinancialPredicate((fin) => {
      const quality = String(fin.snapshot_quality ?? "").trim().toLowerCase();
      return quality === "historical" || fin.estimated === false;
    });
    postItemId = pick?.id ?? null;
  }

  if (!onboardingItemId || !postItemId) {
    throw new Error(
      `Nao foi possivel resolver itens alvo automaticamente. onboarding_item=${onboardingItemId ?? "null"} post_item=${postItemId ?? "null"}`,
    );
  }

  return { onboardingItemId, postItemId };
}

function printCaseResult(r) {
  console.log("\n" + "=".repeat(84));
  console.log(`[SSOT AUDIT] ${r.label}`);
  console.log("=".repeat(84));
  console.log({
    item_id: r.item_id,
    external_order_id: r.external_order_id,
    pass: r.pass,
  });

  console.log("\n- Snapshot metadata:");
  for (const c of r.metadata_check.checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.field} -> ${JSON.stringify(c.got)}`);
  }

  console.log("\n- API consistency (before mutation):");
  for (const block of [r.consistency_before.detail_vs_list, r.consistency_before.detail_vs_executive]) {
    console.log(`  ${block.pass ? "PASS" : "FAIL"}  ${block.label}`);
    for (const c of block.checks) {
      if (!c.pass) {
        console.log(`    FAIL ${c.field}: ref=${JSON.stringify(c.ref)} got=${JSON.stringify(c.got)}`);
      }
    }
  }

  if (!r.immutability?.skipped) {
    console.log("\n- Immutability after temporary config mutation:");
    console.log(`  ${r.immutability.pass ? "PASS" : "FAIL"}`);
    for (const c of r.immutability.checks.filter((x) => !x.pass)) {
      console.log(`    FAIL ${c.field}: before=${JSON.stringify(c.before)} after=${JSON.stringify(c.after)}`);
    }
    console.log("\n- Restore:");
    for (const rr of r.mutation.restore_results ?? []) {
      console.log(`  ${rr.restored ? "PASS" : "FAIL"} restore ${rr.table}:${rr.id} ${rr.error ? rr.error : ""}`);
    }
  } else {
    console.log("\n- Immutability test skipped (--skip-mutation).");
  }
}

async function main() {
  console.log("[SSOT AUDIT] Iniciando auditoria S7-HIST-001..004");
  console.log("[SSOT AUDIT] API_BASE =", API_BASE);
  console.log("[SSOT AUDIT] SKIP_MUTATION =", SKIP_MUTATION);

  const targets = await resolveTargetItems();
  console.log("[SSOT AUDIT] target_onboarding_item =", targets.onboardingItemId);
  console.log("[SSOT AUDIT] target_post_item =", targets.postItemId);

  const onboarding = await auditSaleCase({
    label: "Venda onboarding_import",
    itemId: targets.onboardingItemId,
    expectedSnapshot: {
      snapshot_origin: "onboarding_import",
      snapshot_quality: "reconstructed",
      estimated: true,
    },
  });

  const post = await auditSaleCase({
    label: "Venda post_suse7_sale",
    itemId: targets.postItemId,
    expectedSnapshot: {
      snapshot_origin: "post_suse7_sale",
      snapshot_quality: "historical",
      estimated: false,
    },
  });

  const report = {
    generated_at: new Date().toISOString(),
    api_base: API_BASE,
    skip_mutation: SKIP_MUTATION,
    directives: ["S7-HIST-001", "S7-HIST-002", "S7-HIST-003", "S7-HIST-004"],
    cases: [onboarding, post],
    summary: {
      onboarding_pass: onboarding.pass,
      post_pass: post.pass,
      overall_pass: onboarding.pass && post.pass,
    },
  };

  printCaseResult(onboarding);
  printCaseResult(post);

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2), "utf8");

  console.log("\n" + "=".repeat(84));
  console.log("[SSOT AUDIT] SUMMARY");
  console.log("=".repeat(84));
  console.table([
    {
      venda: "onboarding_import",
      item_id: onboarding.item_id,
      pass: onboarding.pass ? "PASS" : "FAIL",
    },
    {
      venda: "post_suse7_sale",
      item_id: post.item_id,
      pass: post.pass ? "PASS" : "FAIL",
    },
    {
      venda: "overall",
      item_id: "-",
      pass: report.summary.overall_pass ? "PASS" : "FAIL",
    },
  ]);
  console.log("[SSOT AUDIT] Report JSON:", OUTPUT_FILE);

  if (!report.summary.overall_pass) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error("[SSOT AUDIT] fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
