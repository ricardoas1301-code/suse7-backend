// ======================================================================

// Métricas financeiras do catálogo de produtos — SSOT via executive-summary.

// S7-HIST-001..004: sem fallback vivo, Decimal no backend, sem lucro paralelo.

// Paridade com Raio-X: uma chamada scoped por product_id (mesmo motor da aba Vendas).

// ======================================================================



import Decimal from "decimal.js";

import { buildSaleExecutiveSummary } from "../sales/buildSaleExecutiveSummary.js";



const LIFETIME_PERIOD = {

  preset: "lifetime",

  start_date: null,

  end_date: null,

  start_ms: null,

  end_ms_exclusive: null,

};



/** Chamadas scoped em paralelo — equilíbrio entre latência e carga no DEV. */

const CATALOG_PRODUCT_SCOPE_CONCURRENCY = 8;



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @returns {Promise<Record<string, number>>}

 */

async function fetchAdsLinkedCountByProductId(supabase, userId) {

  /** @type {Record<string, number>} */

  const counts = {};

  const pageSize = 1000;

  let offset = 0;



  while (true) {

    const { data, error } = await supabase

      .from("marketplace_listings")

      .select("product_id")

      .eq("user_id", userId)

      .not("product_id", "is", null)

      .range(offset, offset + pageSize - 1);



    if (error) throw error;



    const page = Array.isArray(data) ? data : [];

    for (const row of page) {

      const pid = row?.product_id != null ? String(row.product_id).trim() : "";

      if (!pid) continue;

      counts[pid] = (counts[pid] ?? 0) + 1;

    }



    if (page.length < pageSize) break;

    offset += pageSize;

  }



  return counts;

}



/**

 * @template T, R

 * @param {T[]} items

 * @param {number} concurrency

 * @param {(item: T, index: number) => Promise<R>} fn

 * @returns {Promise<R[]>}

 */

async function runWithConcurrency(items, concurrency, fn) {

  /** @type {R[]} */

  const out = [];

  for (let i = 0; i < items.length; i += concurrency) {

    const chunk = items.slice(i, i + concurrency);

    const results = await Promise.all(chunk.map((item, idx) => fn(item, i + idx)));

    out.push(...results);

  }

  return out;

}



/**

 * Mesma base do Raio-X (ProductFinancialRayXPanel): ticket = faturamento ÷ unidades.

 * @param {string} pid

 * @param {Record<string, unknown> | null | undefined} summary

 */

function summaryToCatalogFinancialRow(pid, summary) {

  const s = summary ?? {};

  const qty = Math.trunc(Number(s.items_quantity_sold ?? s.orders_count) || 0);

  const grossStr = s.gross_sales_brl != null ? String(s.gross_sales_brl) : "0.00";



  /** @type {string | null} */

  let averageTicket = null;

  if (qty > 0) {

    try {

      averageTicket = new Decimal(grossStr.replace(",", "."))

        .div(qty)

        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)

        .toFixed(2);

    } catch {

      averageTicket = null;

    }

  }



  const profitStr =

    s.contribution_profit_brl != null

      ? String(s.contribution_profit_brl)

      : s.net_profit_brl != null

        ? String(s.net_profit_brl)

        : "0.00";

  const marginStr =

    s.contribution_margin_percent != null ? String(s.contribution_margin_percent) : "0.00";



  return {

    product_id: pid,

    quantity_sold: qty,

    gross_sales_brl: grossStr,

    average_ticket_brl: averageTicket,

    contribution_profit_brl: profitStr,

    contribution_margin_percent: marginStr,

  };

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {{ startedAt?: number }} [options]

 */

export async function buildProductCatalogFinancial(supabase, userId, options = {}) {

  const startedAt = options.startedAt ?? Date.now();



  const adsLinkedCountByProductId = await fetchAdsLinkedCountByProductId(supabase, userId);

  const productIds = Object.keys(adsLinkedCountByProductId);



  /** @type {Record<string, Record<string, unknown>>} */

  const byProductId = {};

  let truncatedScan = false;

  /** @type {Set<string>} */

  const warnings = new Set();



  await runWithConcurrency(productIds, CATALOG_PRODUCT_SCOPE_CONCURRENCY, async (pid) => {

    try {

      const executive = await buildSaleExecutiveSummary(

        supabase,

        userId,

        {

          filter: "all",

          product_id: pid,

          period: LIFETIME_PERIOD,

          ranking_limit: 10,

        },

        { startedAt },

      );



      if (executive?.truncated_scan) truncatedScan = true;

      for (const w of executive?.data_quality?.warnings ?? []) {

        if (w != null && String(w).trim() !== "") warnings.add(String(w).trim());

      }



      byProductId[pid] = summaryToCatalogFinancialRow(pid, executive?.summary);

    } catch (error) {

      console.warn("[Suse7][catalog-financial] product_scope_failed", {

        product_id: pid,

        message: error?.message ?? String(error),

      });

      warnings.add(

        `Falha ao calcular métricas do produto ${pid}: ${error?.message ?? "erro desconhecido"}`.slice(

          0,

          200,

        ),

      );

    }

  });



  return {

    ok: true,

    source: "executive-summary-ssot-product-scope",

    period: {

      preset: LIFETIME_PERIOD.preset,

      start_date: LIFETIME_PERIOD.start_date,

      end_date: LIFETIME_PERIOD.end_date,

    },

    by_product_id: byProductId,

    ads_linked_count_by_product_id: adsLinkedCountByProductId,

    data_quality: {

      status: warnings.size > 0 ? "partial" : "complete",

      warnings: [...warnings],

    },

    truncated_scan: truncatedScan,

  };

}

