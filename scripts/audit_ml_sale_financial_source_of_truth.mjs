#!/usr/bin/env node
/**
 * Auditoria fonte da verdade — Raio-X financeiro ML (DEV).
 *
 * Uso:
 *   node scripts/audit_ml_sale_financial_source_of_truth.mjs
 *   node scripts/audit_ml_sale_financial_source_of_truth.mjs --refresh
 *   node scripts/audit_ml_sale_financial_source_of_truth.mjs 2000018523593692
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Decimal from "decimal.js";
import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  fetchMercadoLivreOrderDiscountsById,
  fetchMercadoLivreShipmentById,
  fetchOrderById,
} from "../src/handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { resolveMercadoLivreFinancialFormula } from "../src/domain/sales/mercadoLivreSaleFinancialFormula.js";
import { resolveMercadoLivreShipmentIdFromOrder } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import { refreshSaleFinancialContractByItemId } from "../src/services/sales/saleFinancialContractRefresh.js";

dotenv.config({ path: ".env.vercel" });
dotenv.config({ path: ".env.local" });
dotenv.config();

/** Painel ML informado pelo time — chave = ID exibido no painel ML. */
const ML_PANEL = {
  "2000018523593692": {
    label: "DIVERGENTE",
    gross: "558.60",
    fee: "78.21",
    shipping: "83.25",
    rebate: null,
    net: "397.14",
  },
  "2000018522414612": {
    label: "BATENDO",
    gross: "400.50",
    fee: "54.07",
    shipping: "74.95",
    rebate: null,
    net: "271.48",
  },
  "2000018521633060": {
    label: "DIVERGENTE",
    gross: "105.72",
    fee: "17.44",
    shipping: "17.09",
    rebate: "5.20",
    net: "76.39",
  },
  "2000018577460216": {
    label: "BATENDO",
    gross: "68.62",
    fee: "11.32",
    shipping: "9.95",
    rebate: "2.12",
    net: "49.47",
  },
  "2000018521985682": {
    label: "BATENDO",
    gross: "109.90",
    fee: "18.13",
    shipping: "16.15",
    rebate: null,
    net: "75.62",
  },
  "2000016504327334": {
    label: "BATENDO",
    gross: "117.00",
    fee: "21.06",
    shipping: "19.85",
    rebate: null,
    net: "76.09",
  },
};

/**
 * Mapeamento painel/relatório → external_order_id no Supabase DEV (dígito 65 vs 85).
 * Ajuste quando o pedido existir com outro ID no banco.
 */
const DB_ORDER_ALIASES = {
  "2000018523593692": "2000016523593692",
  "2000018522414612": "2000016522414612",
  "2000018521633060": "2000016521263060",
  "2000018577460216": "2000016517460216",
  "2000018521985682": "2000016521985682",
  "2000016504327334": "2000016504327334",
};

const DEFAULT_ORDERS = Object.keys(ML_PANEL);
const doRefresh = process.argv.includes("--refresh");
const filterOrders = process.argv.filter((a) => /^\d{10,}$/.test(a));

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) {
  console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

function diff(a, b) {
  if (a == null && b == null) return "0.00";
  const da = new Decimal(a ?? 0);
  const db = new Decimal(b ?? 0);
  return da.minus(db).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function pickFin(raw) {
  const fin = raw?._s7_financial;
  return fin && typeof fin === "object" ? fin : null;
}

function buildLineage(order, line, fin, endpoints) {
  return {
    endpoints_called: endpoints,
    valor_da_venda: {
      endpoint: "GET /orders/:id",
      raw_fields: {
        "line.unit_price": line?.unit_price ?? null,
        "line.total_amount": line?.total_amount ?? null,
        "line.gross_price": line?.gross_price ?? null,
        "order.total_amount": order?.total_amount ?? null,
      },
      normalized_brl: fin.gross_sale_amount_brl,
      persisted_brl: fin.gross_sale_amount_brl,
      source_path: fin._sources?.gross ?? "line.total_or_unit_x_qty",
    },
    tarifa_comissao: {
      endpoints: ["GET /orders/:id", "GET /orders/:id/discounts"],
      raw_fields: {
        "line.sale_fee": line?.sale_fee ?? null,
        "line.sale_fee_details": line?.sale_fee_details ?? null,
        "payments[].marketplace_fee": Array.isArray(order?.payments)
          ? order.payments.map((p, i) => ({ i, marketplace_fee: p?.marketplace_fee, sale_fee: p?.sale_fee }))
          : null,
      },
      fee_candidates: fin.formula_debug?.fee_candidates ?? null,
      contract: fin.marketplace_fee ?? null,
      normalized_gross_brl: fin.marketplace_fee_amount_brl,
      normalized_net_brl: fin.marketplace_fee_net_amount_brl,
      percent: fin.marketplace_fee_percent,
      source_path:
        fin.marketplace_fee?.raw_amount_source_path ?? fin._sources?.fee_gross ?? null,
    },
    envios: {
      endpoint: "GET /shipments/:id",
      shipping_candidates: fin.formula_debug?.selected_shipping
        ? fin.formula_debug.shipping_candidates
        : null,
      selected: fin.formula_debug?.selected_shipping ?? null,
      normalized_brl: fin.shipping_amount_brl,
      source_path: fin._sources?.shipping ?? null,
    },
    descontos_e_bonus: {
      endpoint: "GET /orders/:id/discounts",
      discounts_details: fin.formula_debug?.discounts_details ?? null,
      marketplace_rebate: fin.marketplace_rebate ?? null,
      rebate_resolve: fin.formula_debug?.marketplace_rebate_resolve ?? null,
      positive_adjustments_brl: fin.positive_adjustments_brl ?? null,
      source_path: fin.marketplace_rebate?.raw_source_path ?? fin._sources?.positive_adjustments ?? null,
    },
    valor_recebido: {
      formula: "gross - fee_gross - shipping + explicit_rebate",
      formula_debug_net: fin.formula_debug?.final_net ?? null,
      normalized_brl: fin.net_received_amount_brl,
      source_path: fin._sources?.net ?? "computed",
    },
  };
}

function diagnose(ml, s7, lineage) {
  const notes = [];
  const dFee = diff(s7.fee, ml.fee);
  const dNet = diff(s7.net, ml.net);
  const dRebate = diff(s7.rebate, ml.rebate);

  if (dFee !== "0.00") {
    const lineFee = lineage.tarifa_comissao.raw_fields["line.sale_fee"];
    const grossPrice = lineage.valor_da_venda.raw_fields["line.gross_price"];
    const unit = lineage.valor_da_venda.raw_fields["line.unit_price"];
    if (lineFee != null && ml.fee && Math.abs(Number(lineFee) - Number(ml.fee)) > 1) {
      notes.push(
        `tarifa: line.sale_fee (${lineFee}) ≠ tarifa painel (${ml.fee}); provável venda promocional ou tarifa bruta vs líquida`,
      );
    }
    if (grossPrice != null && unit != null && grossPrice > unit) {
      notes.push("tarifa: gross_price > unit_price — promo; matcher catálogo ou payments pode divergir");
    }
    const contractPath = lineage.tarifa_comissao.source_path ?? "";
    if (contractPath.includes("line.sale_fee") && !contractPath.includes("promo")) {
      notes.push(`tarifa: contrato usou ${contractPath} em vez de tarifa bruta do painel`);
    }
  }

  if (dRebate !== "0.00" && (s7.rebate != null || ml.rebate != null)) {
    const rej = lineage.descontos_e_bonus.rebate_resolve?.reject_reason;
    const disc = lineage.descontos_e_bonus.discounts_details ?? [];
    if (s7.rebate && ml.rebate == null) {
      notes.push(
        "rebate: Suse7 exibe descontos mas painel ML não — verificar discounts API genérica (funding vazio/cupom)",
      );
    }
    if (s7.rebate == null && ml.rebate) {
      notes.push(`rebate: painel tem estorno ${ml.rebate} mas resolver rejeitou: ${rej ?? "unknown"}`);
    }
    if (disc.length > 0 && dRebate !== "0.00") {
      notes.push(`rebate: discounts API details count=${disc.length} — revisar funding_mode`);
    }
  }

  if (dNet !== "0.00") {
    notes.push(
      `net: diferença ${dNet} — geralmente consequência de tarifa (${dFee}) e/ou rebate (${dRebate})`,
    );
  }

  if (notes.length === 0) notes.push("valores alinhados com painel ML após refresh");
  return notes;
}

async function auditOrder(panelOrderId) {
  const panel = ML_PANEL[panelOrderId];
  if (!panel) {
    console.warn("Pedido sem expectativa no painel:", panelOrderId);
    return null;
  }

  const dbOrderId = DB_ORDER_ALIASES[panelOrderId] ?? panelOrderId;

  const { data: ord, error: oErr } = await supabase
    .from("sales_orders")
    .select("id,user_id,external_order_id,marketplace_account_id,seller_company_id,raw_json")
    .eq("external_order_id", dbOrderId)
    .maybeSingle();
  if (oErr) throw oErr;
  if (!ord) {
    console.error("Pedido não encontrado no banco:", dbOrderId, "(painel:", panelOrderId, ")");
    return null;
  }

  const extOrder = String(ord.external_order_id ?? dbOrderId);

  const { data: items, error: iErr } = await supabase
    .from("sales_order_items")
    .select("id,marketplace_account_id,raw_json,gross_amount,fee_amount")
    .eq("sales_order_id", ord.id);
  if (iErr) throw iErr;

  const item = items?.[0];
  if (!item) {
    console.error("Sem sales_order_items para", extOrder);
    return null;
  }

  const accountId = String(item.marketplace_account_id || ord.marketplace_account_id || "").trim();
  let accessToken = null;
  try {
    accessToken = await getValidMLToken(ord.user_id, { marketplaceAccountId: accountId });
  } catch (e) {
    console.warn("[audit] ml_token_unavailable", e instanceof Error ? e.message : e);
  }

  if (doRefresh && accessToken) {
    await refreshSaleFinancialContractByItemId(supabase, ord.user_id, String(item.id), { accessToken });
    const { data: refreshed } = await supabase
      .from("sales_order_items")
      .select("raw_json,gross_amount,fee_amount")
      .eq("id", item.id)
      .maybeSingle();
    if (refreshed) Object.assign(item, refreshed);
  }

  const endpoints = [];
  let order = ord.raw_json && typeof ord.raw_json === "object" ? { ...ord.raw_json } : {};
  let line = null;
  let discountsSnapshot = null;
  let shipmentSnapshot = null;

  if (accessToken) {
    try {
      const fresh = await fetchOrderById(accessToken, extOrder, { marketplaceAccountId: accountId });
      // ML order id = external_order_id no banco
      order = { ...order, ...fresh };
      endpoints.push("GET /orders/:id");
      line = Array.isArray(fresh.order_items) ? fresh.order_items[0] : null;
    } catch (e) {
      console.warn("[audit] order_fetch_failed", e instanceof Error ? e.message : e);
    }

    try {
      discountsSnapshot = await fetchMercadoLivreOrderDiscountsById(accessToken, extOrder, {
        marketplaceAccountId: accountId,
      });
      endpoints.push("GET /orders/:id/discounts");
    } catch (e) {
      console.warn("[audit] discounts_fetch_failed", e instanceof Error ? e.message : e);
    }

    const shipId = resolveMercadoLivreShipmentIdFromOrder(order);
    if (shipId) {
      try {
        shipmentSnapshot = await fetchMercadoLivreShipmentById(accessToken, shipId, {
          marketplaceAccountId: accountId,
        });
        endpoints.push("GET /shipments/:id");
      } catch (e) {
        console.warn("[audit] shipment_fetch_failed", e instanceof Error ? e.message : e);
      }
    }
  }

  if (!line && Array.isArray(order.order_items)) line = order.order_items[0];
  if (!line && item.raw_json) line = item.raw_json;

  const fin = resolveMercadoLivreFinancialFormula({
    order,
    line: line && typeof line === "object" ? line : {},
    shipmentSnapshot,
    discountsSnapshot,
    externalOrderItemId: null,
  });

  const persisted = pickFin(item.raw_json);
  const lineage = buildLineage(order, line, fin, endpoints);

  const s7 = {
    gross: fin.gross_sale_amount_brl,
    fee: fin.marketplace_fee_amount_brl,
    shipping: fin.shipping_amount_brl,
    rebate: fin.marketplace_rebate?.amount_brl ?? null,
    net: fin.net_received_amount_brl,
  };

  console.log("\n" + "=".repeat(72));
  console.log("[S7 RAYX FINANCIAL AUDIT] Pedido painel:", panelOrderId, "| DB:", extOrder);
  console.log("=".repeat(72));
  console.log({
    panel_order_id: panelOrderId,
    order_id: ord.id,
    item_id: item.id,
    external_order_id: extOrder,
    marketplace_account_id: accountId,
    seller_company_id: ord.seller_company_id,
    snapshot_version: fin.snapshot_version ?? persisted?.snapshot_version ?? null,
    snapshot_updated_at: persisted?.updated_at ?? null,
    refreshed: doRefresh,
    status_expected: panel.label,
  });

  console.log("\n--- Mapa de origem por linha ---");
  console.log(JSON.stringify(lineage, null, 2));

  console.log("\n--- Painel ML (referência informada) vs Suse7 pós-audit ---");
  console.log({
    painel_ml: {
      valor_da_venda: panel.gross,
      tarifa: panel.fee,
      envios: panel.shipping,
      estorno_rebate: panel.rebate,
      total_recebido: panel.net,
    },
    suse7: s7,
    diferenca: {
      valor_da_venda: diff(s7.gross, panel.gross),
      tarifa: diff(s7.fee, panel.fee),
      envios: diff(s7.shipping, panel.shipping),
      descontos_e_bonus: diff(s7.rebate, panel.rebate),
      total_recebido: diff(s7.net, panel.net),
    },
  });

  const notes = diagnose(panel, s7, lineage);
  console.log("\n--- Diagnóstico provável ---");
  for (const n of notes) console.log("-", n);

  const match =
    diff(s7.gross, panel.gross) === "0.00" &&
    diff(s7.fee, panel.fee) === "0.00" &&
    diff(s7.shipping, panel.shipping) === "0.00" &&
    diff(s7.rebate, panel.rebate) === "0.00" &&
    diff(s7.net, panel.net) === "0.00";

  console.log("\n--- Resultado ---", match ? "BATE" : "DIVERGE");
  return { extOrder: panelOrderId, dbOrderId: extOrder, match, s7, panel, lineage, notes };
}

async function main() {
  const orders = filterOrders.length > 0 ? filterOrders : DEFAULT_ORDERS;
  console.log("[S7 RAYX FINANCIAL AUDIT] orders=", orders.join(", "), "refresh=", doRefresh);

  /** @type {Array<{ extOrder: string; match: boolean }>} */
  const summary = [];

  for (const ext of orders) {
    const r = await auditOrder(ext);
    if (r) summary.push({ extOrder: r.extOrder, match: r.match });
  }

  console.log("\n" + "=".repeat(72));
  console.log("[S7 RAYX FINANCIAL AUDIT] RESUMO");
  console.table(
    summary.map((s) => ({
      pedido: s.extOrder,
      resultado: s.match ? "BATE" : "DIVERGE",
      painel_ref: ML_PANEL[s.extOrder]?.label,
    })),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
