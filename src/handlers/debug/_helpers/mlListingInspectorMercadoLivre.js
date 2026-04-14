// ======================================================
// Inspector de campos — Mercado Livre (diagnóstico / futuro multi-marketplace).
// Não altera dados; apenas agrega DB + API para visualização.
// ======================================================

import Decimal from "decimal.js";
import { ML_MARKETPLACE_SLUG } from "../../ml/_helpers/mlMarketplace.js";
import {
  extractNetReceivableExplicit,
  extractPromotionPrice,
  extractSaleFee,
  extractShippingCost,
  toFiniteNumber,
} from "../../ml/_helpers/mlItemMoneyExtract.js";
import { computeMercadoLivreUnitNetProceeds } from "../../ml/_helpers/netProceeds/mercadoLivreNetProceedsCalculator.js";
import { extractSellerSku } from "../../ml/_helpers/mlItemSkuExtract.js";

/** @typedef {import("../../ml/_helpers/mlItemSkuExtract.js").ATTENTION_REASON_SKU_PENDING_ML} _ */

/**
 * @typedef {object} InspectorContext
 * @property {Record<string, unknown> | null} listing
 * @property {Record<string, unknown> | null} health
 * @property {Record<string, unknown> | null} metrics
 * @property {Record<string, unknown> | null} product
 * @property {Record<string, unknown> | null} item
 * @property {Record<string, unknown> | null} listingPricesRow
 * @property {Record<string, unknown> | null} salePrice
 * @property {Record<string, unknown> | null} description
 * @property {number | null} visitsApiTotal
 * @property {Record<string, unknown> | null} performanceApi
 * @property {boolean} tokenAvailable
 * @property {Record<string, string>} apiErrors
 */

/** @param {unknown} v */
function isEmptyValue(v) {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (typeof v === "number" && !Number.isFinite(v)) return true;
  return false;
}

/** @param {unknown} v */
function displayValue(v) {
  if (v == null) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) {
    try {
      if (Number.isInteger(v)) return String(v);
      return new Decimal(String(v)).toFixed(4).replace(/\.?0+$/, "");
    } catch {
      return String(v);
    }
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @param {string} col
 */
function col(row, col) {
  if (!row || typeof row !== "object") return null;
  return Object.prototype.hasOwnProperty.call(row, col) ? row[col] : null;
}

/**
 * Valor simples no objeto item (primeiro segmento de marketplace_field).
 * Caminhos aninhados ficam com resolveApi explícito no spec.
 * @param {InspectorContext} ctx
 * @param {{ marketplace_field: string }} spec
 */
function defaultApiFromItem(spec, ctx) {
  if (!ctx.item || typeof ctx.item !== "object") return null;
  const mf = spec.marketplace_field;
  if (!mf || mf.includes("—")) return null;
  const first = mf.split("|")[0].trim();
  const top = first.split(".")[0].trim();
  if (!top || top === "—") return null;
  if (Object.prototype.hasOwnProperty.call(ctx.item, top)) {
    return /** @type {Record<string, unknown>} */ (ctx.item)[top];
  }
  return null;
}

/**
 * @param {InspectorContext} ctx
 * @param {{ table: string; column: string }} loc
 */
function dbPick(ctx, loc) {
  const t = loc.table;
  const c = loc.column;
  if (t === "marketplace_listings") return col(ctx.listing, c);
  if (t === "marketplace_listing_health") return col(ctx.health, c);
  if (t === "listing_sales_metrics") return col(ctx.metrics, c);
  if (t === "products") return col(ctx.product, c);
  return null;
}

/**
 * @param {InspectorContext} ctx
 * @param {(ctx: InspectorContext) => unknown} fn
 */
function safeApi(fn, ctx) {
  try {
    return fn(ctx);
  } catch {
    return null;
  }
}

/**
 * Definição declarativa por campo (ML). Outros marketplaces terão registries paralelos.
 * @returns {Array<{
 *   id: string;
 *   group: string;
 *   label: string;
 *   suse7_field: string;
 *   db_source_table: string;
 *   db_column: string | null;
 *   marketplace_field: string;
 *   endpoint: string;
 *   value_type: string;
 *   editable_manual: boolean;
 *   api_only: boolean;
 *   nature: string;
 *   notes?: string;
 *   resolveApi?: (ctx: InspectorContext) => unknown;
 *   resolveDb?: (ctx: InspectorContext) => unknown;
 * }>}
 */
export function getMercadoLivreListingFieldSpecs() {
  return [
    {
      id: "listing_uuid",
      group: "Identificação",
      label: "ID interno (Suse7)",
      suse7_field: "marketplace_listings.id",
      db_source_table: "marketplace_listings",
      db_column: "id",
      marketplace_field: "—",
      endpoint: "—",
      value_type: "uuid",
      editable_manual: false,
      api_only: false,
      nature: "imported",
      notes: "Chave primária no Postgres.",
    },
    {
      id: "external_listing_id",
      group: "Identificação",
      label: "ID do anúncio no ML",
      suse7_field: "external_listing_id",
      db_source_table: "marketplace_listings",
      db_column: "external_listing_id",
      marketplace_field: "id",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
    },
    {
      id: "title",
      group: "Identificação",
      label: "Título",
      suse7_field: "title",
      db_source_table: "marketplace_listings",
      db_column: "title",
      marketplace_field: "title",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: false,
      nature: "imported",
    },
    {
      id: "status",
      group: "Status",
      label: "Status do anúncio",
      suse7_field: "status",
      db_source_table: "marketplace_listings",
      db_column: "status",
      marketplace_field: "status",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
    },
    {
      id: "permalink",
      group: "Identificação",
      label: "Permalink",
      suse7_field: "permalink",
      db_source_table: "marketplace_listings",
      db_column: "permalink",
      marketplace_field: "permalink",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
    },
    {
      id: "seller_sku_col",
      group: "Catálogo",
      label: "SKU (colunas)",
      suse7_field: "seller_sku / seller_custom_field",
      db_source_table: "marketplace_listings",
      db_column: "seller_sku",
      marketplace_field: "seller_custom_field | seller_sku | attributes SELLER_SKU",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: true,
      api_only: false,
      nature: "imported",
      notes: "Pode ser informado manualmente via set-sku quando ML não envia SKU.",
      resolveDb: (ctx) =>
        col(ctx.listing, "seller_custom_field") ?? col(ctx.listing, "seller_sku"),
      resolveApi: (ctx) =>
        ctx.item && typeof ctx.item === "object"
          ? extractSellerSku(/** @type {Record<string, unknown>} */ (ctx.item))
          : null,
    },
    {
      id: "product_id",
      group: "Produto",
      label: "Produto vinculado (Suse7)",
      suse7_field: "product_id",
      db_source_table: "marketplace_listings",
      db_column: "product_id",
      marketplace_field: "—",
      endpoint: "Derivado / batchEnsureProductsForListings",
      value_type: "uuid",
      editable_manual: false,
      api_only: false,
      nature: "derived",
      notes: "Vínculo interno após SKU + regras de catálogo.",
    },
    {
      id: "catalog_completeness",
      group: "Catálogo",
      label: "Completude do produto",
      suse7_field: "catalog_completeness",
      db_source_table: "products",
      db_column: "catalog_completeness",
      marketplace_field: "—",
      endpoint: "—",
      value_type: "string",
      editable_manual: false,
      api_only: false,
      nature: "derived",
    },
    {
      id: "attention_reason",
      group: "Catálogo",
      label: "Motivo de atenção",
      suse7_field: "attention_reason",
      db_source_table: "marketplace_listings",
      db_column: "attention_reason",
      marketplace_field: "—",
      endpoint: "Persistência (SKU pendente)",
      value_type: "string",
      editable_manual: false,
      api_only: false,
      nature: "derived",
    },
    {
      id: "financial_analysis_blocked",
      group: "Catálogo",
      label: "Análise financeira bloqueada",
      suse7_field: "financial_analysis_blocked",
      db_source_table: "marketplace_listings",
      db_column: "financial_analysis_blocked",
      marketplace_field: "—",
      endpoint: "Regra interna",
      value_type: "boolean",
      editable_manual: false,
      api_only: false,
      nature: "derived",
    },
    {
      id: "price",
      group: "Preço",
      label: "Preço atual",
      suse7_field: "price",
      db_source_table: "marketplace_listings",
      db_column: "price",
      marketplace_field: "price",
      endpoint: "GET /items/:id",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => (ctx.item && typeof ctx.item === "object" ? ctx.item.price : null),
    },
    {
      id: "original_price",
      group: "Preço",
      label: "Preço original / de lista",
      suse7_field: "original_price",
      db_source_table: "marketplace_listings",
      db_column: "original_price",
      marketplace_field: "original_price | sale_price.regular_amount",
      endpoint: "GET /items/:id | GET /items/:id/sale_price",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const it = ctx.item && typeof ctx.item === "object" ? ctx.item.original_price : null;
        const sp =
          ctx.salePrice && typeof ctx.salePrice === "object"
            ? ctx.salePrice.regular_amount
            : null;
        return it ?? sp ?? null;
      },
    },
    {
      id: "base_price",
      group: "Preço",
      label: "Base price",
      suse7_field: "base_price",
      db_source_table: "marketplace_listings",
      db_column: "base_price",
      marketplace_field: "base_price",
      endpoint: "GET /items/:id",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => (ctx.item && typeof ctx.item === "object" ? ctx.item.base_price : null),
    },
    {
      id: "currency_id",
      group: "Comercial",
      label: "Moeda",
      suse7_field: "currency_id",
      db_source_table: "marketplace_listings",
      db_column: "currency_id",
      marketplace_field: "currency_id",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => (ctx.item && typeof ctx.item === "object" ? ctx.item.currency_id : null),
    },
    {
      id: "listing_type_id",
      group: "Comercial",
      label: "Tipo de anúncio (listing_type_id)",
      suse7_field: "listing_type_id",
      db_source_table: "marketplace_listings",
      db_column: "listing_type_id",
      marketplace_field: "listing_type_id",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) =>
        ctx.item && typeof ctx.item === "object" ? ctx.item.listing_type_id : null,
    },
    {
      id: "available_quantity",
      group: "Comercial",
      label: "Estoque disponível",
      suse7_field: "available_quantity",
      db_source_table: "marketplace_listings",
      db_column: "available_quantity",
      marketplace_field: "available_quantity",
      endpoint: "GET /items/:id",
      value_type: "integer",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) =>
        ctx.item && typeof ctx.item === "object" ? ctx.item.available_quantity : null,
    },
    {
      id: "sold_quantity_listing",
      group: "Vendas",
      label: "Unidades vendidas (snapshot ML)",
      suse7_field: "sold_quantity",
      db_source_table: "marketplace_listings",
      db_column: "sold_quantity",
      marketplace_field: "sold_quantity",
      endpoint: "GET /items/:id",
      value_type: "integer",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => (ctx.item && typeof ctx.item === "object" ? ctx.item.sold_quantity : null),
    },
    {
      id: "metrics_qty_sold",
      group: "Vendas",
      label: "Qtd vendida (pedidos importados)",
      suse7_field: "qty_sold_total",
      db_source_table: "listing_sales_metrics",
      db_column: "qty_sold_total",
      marketplace_field: "—",
      endpoint: "sales_sync → listing_sales_metrics",
      value_type: "integer",
      editable_manual: false,
      api_only: false,
      nature: "calculated",
      notes: "Agregado das vendas Suse7 após sync-sales.",
    },
    {
      id: "metrics_gross",
      group: "Vendas",
      label: "Faturamento bruto (métricas)",
      suse7_field: "gross_revenue_total",
      db_source_table: "listing_sales_metrics",
      db_column: "gross_revenue_total",
      marketplace_field: "—",
      endpoint: "sales_sync",
      value_type: "decimal",
      editable_manual: false,
      api_only: false,
      nature: "calculated",
    },
    {
      id: "metrics_net",
      group: "Vendas",
      label: "Receita líquida (métricas)",
      suse7_field: "net_revenue_total",
      db_source_table: "listing_sales_metrics",
      db_column: "net_revenue_total",
      marketplace_field: "—",
      endpoint: "sales_sync",
      value_type: "decimal",
      editable_manual: false,
      api_only: false,
      nature: "calculated",
    },
    {
      id: "metrics_commission_total",
      group: "Taxas",
      label: "Comissão total (pedidos agregados)",
      suse7_field: "commission_amount_total",
      db_source_table: "listing_sales_metrics",
      db_column: "commission_amount_total",
      marketplace_field: "fee por linha de pedido",
      endpoint: "sales_sync",
      value_type: "decimal",
      editable_manual: false,
      api_only: false,
      nature: "calculated",
      notes: "Soma das taxas nas linhas importadas — não é a mesma coisa que listing_prices.",
    },
    {
      id: "commission_pct_derived",
      group: "Taxas",
      label: "% comissão derivada (bruto×fee nas métricas)",
      suse7_field: "(grid)",
      db_source_table: "—",
      db_column: null,
      marketplace_field: "—",
      endpoint: "Cálculo na grid",
      value_type: "decimal",
      editable_manual: false,
      api_only: false,
      nature: "calculated",
      notes: "Apenas quando gross_revenue_total e commission_amount_total existem.",
      resolveDb: (ctx) => {
        const g = toFiniteNumber(col(ctx.metrics, "gross_revenue_total"));
        const f = toFiniteNumber(col(ctx.metrics, "commission_amount_total"));
        if (g == null || f == null || g <= 0) return null;
        return (f / g) * 100;
      },
      resolveApi: () => null,
    },
    {
      id: "health_sale_fee_percent",
      group: "Taxas",
      label: "Comissão % (health)",
      suse7_field: "sale_fee_percent",
      db_source_table: "marketplace_listing_health",
      db_column: "sale_fee_percent",
      marketplace_field: "sale_fee_details.percentage_fee",
      endpoint: "GET /items (se presente) | GET /sites/.../listing_prices",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const itemFee =
          ctx.item && typeof ctx.item === "object"
            ? extractSaleFee(/** @type {Record<string, unknown>} */ (ctx.item))
            : { percent: null, amount: null };
        const lp = ctx.listingPricesRow?.sale_fee_details
          ? extractSaleFee({
              sale_fee_details: ctx.listingPricesRow.sale_fee_details,
              sale_fee_amount: ctx.listingPricesRow.sale_fee_amount,
            })
          : { percent: null, amount: null };
        return itemFee.percent ?? lp.percent ?? null;
      },
    },
    {
      id: "health_sale_fee_amount",
      group: "Taxas",
      label: "Comissão em R$ (health)",
      suse7_field: "sale_fee_amount",
      db_source_table: "marketplace_listing_health",
      db_column: "sale_fee_amount",
      marketplace_field: "sale_fee_details.gross_amount | sale_fee_amount (listing_prices)",
      endpoint: "GET /items | GET /sites/.../listing_prices",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const itemFee =
          ctx.item && typeof ctx.item === "object"
            ? extractSaleFee(/** @type {Record<string, unknown>} */ (ctx.item))
            : { percent: null, amount: null };
        const lp = ctx.listingPricesRow?.sale_fee_details
          ? extractSaleFee({
              sale_fee_details: ctx.listingPricesRow.sale_fee_details,
              sale_fee_amount: ctx.listingPricesRow.sale_fee_amount,
            })
          : { percent: null, amount: null };
        const rootLp = toFiniteNumber(ctx.listingPricesRow?.sale_fee_amount);
        return itemFee.amount ?? lp.amount ?? rootLp ?? null;
      },
    },
    {
      id: "health_net_receivable",
      group: "Taxas",
      label: "Você recebe (snapshot item / health)",
      suse7_field: "net_receivable",
      db_source_table: "marketplace_listing_health",
      db_column: "net_receivable",
      marketplace_field: "sale_fee_details.net_amount | itens correlatos",
      endpoint: "GET /items/:id",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) =>
        ctx.item && typeof ctx.item === "object"
          ? extractNetReceivableExplicit(/** @type {Record<string, unknown>} */ (ctx.item))
          : null,
    },
    {
      id: "health_shipping_cost",
      group: "Frete",
      label: "Frete (custo snapshot health)",
      suse7_field: "shipping_cost",
      db_source_table: "marketplace_listing_health",
      db_column: "shipping_cost",
      marketplace_field: "shipping.cost | shipping.list_cost",
      endpoint: "GET /items/:id",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) =>
        ctx.item && typeof ctx.item === "object"
          ? extractShippingCost(/** @type {Record<string, unknown>} */ (ctx.item))
          : null,
    },
    {
      id: "metrics_shipping_share",
      group: "Frete",
      label: "Frete (share nos pedidos)",
      suse7_field: "shipping_share_total",
      db_source_table: "listing_sales_metrics",
      db_column: "shipping_share_total",
      marketplace_field: "—",
      endpoint: "sales_sync",
      value_type: "decimal",
      editable_manual: false,
      api_only: false,
      nature: "calculated",
    },
    {
      id: "health_shipping_logistic",
      group: "Logística",
      label: "Tipo logístico (health)",
      suse7_field: "shipping_logistic_type",
      db_source_table: "marketplace_listing_health",
      db_column: "shipping_logistic_type",
      marketplace_field: "shipping.logistic_type",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const sh = ctx.item?.shipping;
        return sh && typeof sh === "object" ? sh.logistic_type ?? null : null;
      },
    },
    {
      id: "health_promotion_price",
      group: "Promoção",
      label: "Preço promocional efetivo (health)",
      suse7_field: "promotion_price",
      db_source_table: "marketplace_listing_health",
      db_column: "promotion_price",
      marketplace_field: "original_price > price | sale_price",
      endpoint: "GET /items | GET /items/:id/sale_price",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        if (ctx.item && typeof ctx.item === "object") {
          const p = extractPromotionPrice(/** @type {Record<string, unknown>} */ (ctx.item));
          if (p != null) return p;
        }
        const sp = ctx.salePrice;
        if (sp && typeof sp === "object") {
          const a = toFiniteNumber(sp.amount);
          const r = toFiniteNumber(sp.regular_amount);
          if (r != null && a != null && r > a) return a;
        }
        return null;
      },
    },
    {
      id: "sale_price_amount",
      group: "Promoção",
      label: "sale_price.amount (API)",
      suse7_field: "—",
      db_source_table: "—",
      db_column: null,
      marketplace_field: "sale_price.amount",
      endpoint: "GET /items/:id/sale_price",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "api_only",
      resolveDb: () => null,
      resolveApi: (ctx) => (ctx.salePrice && typeof ctx.salePrice === "object" ? ctx.salePrice.amount : null),
    },
    {
      id: "health_visits",
      group: "Métricas",
      label: "Visitas",
      suse7_field: "visits",
      db_source_table: "marketplace_listing_health",
      db_column: "visits",
      marketplace_field: "—",
      endpoint: "GET /visits/items | GET /items/visits",
      value_type: "integer",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => ctx.visitsApiTotal,
    },
    {
      id: "health_quality_score",
      group: "Qualidade / Saúde",
      label: "Score de qualidade",
      suse7_field: "listing_quality_score",
      db_source_table: "marketplace_listing_health",
      db_column: "listing_quality_score",
      marketplace_field: "performance.score",
      endpoint: "GET /items/:id/performance",
      value_type: "decimal",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const perf = ctx.performanceApi;
        if (!perf || typeof perf !== "object") return null;
        const h = perf.health;
        let healthScore = null;
        if (typeof h === "number" && Number.isFinite(h)) healthScore = h;
        else if (h && typeof h === "object") healthScore = toFiniteNumber(h.health ?? h.score);
        return toFiniteNumber(perf.score ?? healthScore ?? perf.level_score);
      },
    },
    {
      id: "health_quality_status",
      group: "Qualidade / Saúde",
      label: "Status de qualidade",
      suse7_field: "listing_quality_status",
      db_source_table: "marketplace_listing_health",
      db_column: "listing_quality_status",
      marketplace_field: "performance.level",
      endpoint: "GET /items/:id/performance",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const perf = ctx.performanceApi;
        if (!perf || typeof perf !== "object") return null;
        if (perf.level != null) return String(perf.level);
        if (perf.status != null) return String(perf.status);
        if (perf.level_wording != null) return String(perf.level_wording);
        return null;
      },
    },
    {
      id: "health_experience",
      group: "Qualidade / Saúde",
      label: "Experiência de compra",
      suse7_field: "experience_status",
      db_source_table: "marketplace_listing_health",
      db_column: "experience_status",
      marketplace_field: "performance.buying_experience",
      endpoint: "GET /items/:id/performance",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const perf = ctx.performanceApi;
        if (!perf || typeof perf !== "object") return null;
        const buy =
          perf.buying_experience ??
          perf.buyer_experience ??
          perf.shopping_experience ??
          perf.purchase_experience ??
          perf.experience;
        if (buy && typeof buy === "object") {
          if (buy.status != null) return String(buy.status);
          if (buy.level != null) return String(buy.level);
        }
        return null;
      },
    },
    {
      id: "listing_health_percent",
      group: "Qualidade / Saúde",
      label: "Health no payload do item",
      suse7_field: "health",
      db_source_table: "marketplace_listings",
      db_column: "health",
      marketplace_field: "health",
      endpoint: "GET /items/:id",
      value_type: "json",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => (ctx.item && typeof ctx.item === "object" ? ctx.item.health ?? null : null),
    },
    {
      id: "pictures_count",
      group: "Catálogo",
      label: "Qtd fotos",
      suse7_field: "pictures_count",
      db_source_table: "marketplace_listings",
      db_column: "pictures_count",
      marketplace_field: "pictures.length",
      endpoint: "GET /items/:id",
      value_type: "integer",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const p = ctx.item?.pictures;
        return Array.isArray(p) ? p.length : null;
      },
    },
    {
      id: "variations_count",
      group: "Catálogo",
      label: "Qtd variações",
      suse7_field: "variations_count",
      db_source_table: "marketplace_listings",
      db_column: "variations_count",
      marketplace_field: "variations.length",
      endpoint: "GET /items/:id",
      value_type: "integer",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => {
        const v = ctx.item?.variations;
        return Array.isArray(v) ? v.length : null;
      },
    },
    {
      id: "api_last_seen",
      group: "Campos internos",
      label: "Último sync (api_last_seen_at)",
      suse7_field: "api_last_seen_at",
      db_source_table: "marketplace_listings",
      db_column: "api_last_seen_at",
      marketplace_field: "—",
      endpoint: "Persistência",
      value_type: "date",
      editable_manual: false,
      api_only: false,
      nature: "derived",
    },
    {
      id: "category_id",
      group: "Comercial",
      label: "Categoria ML",
      suse7_field: "category_id",
      db_source_table: "marketplace_listings",
      db_column: "category_id",
      marketplace_field: "category_id",
      endpoint: "GET /items/:id",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "imported",
      resolveApi: (ctx) => (ctx.item && typeof ctx.item === "object" ? ctx.item.category_id : null),
    },
    {
      id: "listing_prices_match",
      group: "Taxas",
      label: "Linha listing_prices (tipo do anúncio)",
      suse7_field: "—",
      db_source_table: "—",
      db_column: null,
      marketplace_field: "listing_type_id + price + …",
      endpoint: "GET /sites/:site_id/listing_prices",
      value_type: "string",
      editable_manual: false,
      api_only: true,
      nature: "api_only",
      notes: "Objeto completo em raw_payloads.listing_prices_row; coluna = listing_type_id da linha escolhida.",
      resolveDb: () => null,
      resolveApi: (ctx) =>
        ctx.listingPricesRow && ctx.listingPricesRow.listing_type_id != null
          ? String(ctx.listingPricesRow.listing_type_id)
          : null,
    },
  ];
}

/**
 * @param {string} nature
 */
/**
 * @param {Record<string, unknown> | null | undefined} row
 */
function listingPricesRowFeeSnapshot(row) {
  if (!row || typeof row !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const amtRaw = r.sale_fee_amount ?? r.selling_fee ?? r.sale_fee;
  const amt = toFiniteNumber(amtRaw);
  return {
    listing_type_id: r.listing_type_id ?? r.mapping ?? null,
    sale_fee_amount_coerced: amt,
    has_sale_fee_details: Boolean(r.sale_fee_details),
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} h
 */
function healthMoneySnapshot(h) {
  if (!h || typeof h !== "object") return null;
  return {
    sale_fee_amount: h.sale_fee_amount ?? null,
    sale_fee_percent: h.sale_fee_percent ?? null,
    shipping_cost: h.shipping_cost ?? null,
    net_receivable: h.net_receivable ?? null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} snap
 */
function snapshotHasUsableListingPricesFee(snap) {
  if (!snap) return false;
  const a = snap.sale_fee_amount_coerced;
  if (a != null && a > 0) return true;
  return snap.has_sale_fee_details === true;
}

/**
 * @param {Record<string, unknown> | null | undefined} hm
 */
function snapshotHasUsableHealthFee(hm) {
  if (!hm) return false;
  const a = toFiniteNumber(hm.sale_fee_amount);
  const p = toFiniteNumber(hm.sale_fee_percent);
  return (a != null && a > 0) || (p != null && p > 0);
}

/**
 * Diagnóstico objetivo: onde o repasse “morre” no pipeline.
 * @param {{
 *   lpSnap: ReturnType<typeof listingPricesRowFeeSnapshot>;
 *   healthSnap: ReturnType<typeof healthMoneySnapshot>;
 *   np: { has_valid_data?: boolean; source?: string; insufficient_reason?: string | null } | null;
 *   tokenAvailable: boolean;
 * }} p
 */
function buildRepassePipelineDiagnosis(p) {
  const { lpSnap, healthSnap, np, tokenAvailable } = p;
  const stage = /** @type {string[]} */ ([]);
  const notes = /** @type {string[]} */ ([]);

  if (!tokenAvailable) {
    stage.push("ml_api_token");
    notes.push("Token ML indisponível — listing_prices ao vivo não foi chamado neste request.");
    return { failing_stage: stage[0], stages_checked: stage, notes };
  }

  if (np && np.has_valid_data === true) {
    return {
      failing_stage: null,
      stages_checked: [
        "mercado_libre_listing_prices",
        "persistence_marketplace_listing_health",
        "net_proceeds",
      ],
      notes: [
        `net_proceeds válido (source=${String(np.source)}).${
          np.source === "orders_fallback"
            ? " Usa média de comissão (e frete) dos pedidos importados."
            : ""
        }`,
      ],
    };
  }

  const lpOk = snapshotHasUsableListingPricesFee(lpSnap);
  if (!lpOk) {
    stage.push("mercado_libre_listing_prices");
    notes.push(
      "GET /sites/:id/listing_prices não devolveu linha com taxa utilizável para o item atual (preço/tipo/categoria/frete podem não bater com nenhuma linha)."
    );
  }

  const hOk = snapshotHasUsableHealthFee(healthSnap);
  if (!hOk) {
    stage.push("persistence_marketplace_listing_health");
    if (lpOk) {
      notes.push(
        "listing_prices ao vivo tem taxa, mas o banco (health) está sem sale_fee_amount/percent — rode sync de anúncios ou POST /api/ml/backfill-listing-health após OAuth."
      );
    } else {
      notes.push("Sem taxa persistida em marketplace_listing_health.");
    }
  }

  if (np && np.has_valid_data !== true) {
    stage.push("net_proceeds_calculator_or_listing_shape");
    notes.push(
      `computeMercadoLivreUnitNetProceeds → has_valid_data=false source=${String(np.source)} insufficient_reason=${np.insufficient_reason != null ? String(np.insufficient_reason) : "null"}`
    );
  }

  if (stage.length === 0) {
    return {
      failing_stage: null,
      stages_checked: ["mercado_libre_listing_prices", "persistence_marketplace_listing_health", "net_proceeds"],
      notes: ["Pipeline completo com taxa persistida e net_proceeds marcado como válido pelo calculador."],
    };
  }

  return { failing_stage: stage[0], stages_checked: stage, notes };
}

function statusFromValues(dbVal, apiVal, nature, tokenAvailable) {
  if (!tokenAvailable && nature === "api_only") return "unavailable";
  if (nature === "calculated") {
    if (!isEmptyValue(dbVal)) return "calculated";
    return "empty";
  }
  if (nature === "unmapped") return "not_mapped";

  const d = isEmptyValue(dbVal);
  const a = isEmptyValue(apiVal);
  if (!d && !a) return "ok";
  if (!d && a && (nature === "imported" || nature === "derived")) return "ok";
  if (d && !a) return "missing";
  if (d && a) return "empty";
  return "ok";
}

/**
 * @param {InspectorContext} ctx
 */
export function buildMlListingInspectorResponse(ctx) {
  const specs = getMercadoLivreListingFieldSpecs();
  /** @type {Record<string, { group: string; fields: object[] }>} */
  const groupMap = {};

  let filled = 0;
  let empty = 0;
  let apiOnlyCount = 0;
  let calculated = 0;
  let unmapped = 0;

  for (const spec of specs) {
    const dbValRaw =
      spec.resolveDb != null
        ? safeApi(spec.resolveDb, ctx)
        : spec.db_column
          ? dbPick(ctx, { table: spec.db_source_table, column: spec.db_column })
          : null;
    let apiValRaw =
      spec.resolveApi != null ? safeApi(spec.resolveApi, ctx) : defaultApiFromItem(spec, ctx);

    const dbDisplay = displayValue(dbValRaw);
    const apiDisplay = displayValue(apiValRaw);

    const status = statusFromValues(dbValRaw, apiValRaw, spec.nature, ctx.tokenAvailable);

    if (spec.api_only) apiOnlyCount += 1;
    if (spec.nature === "calculated") calculated += 1;
    if (spec.nature === "unmapped") unmapped += 1;
    const hasDb = !isEmptyValue(dbValRaw);
    const hasApi = !isEmptyValue(apiValRaw);
    if (hasDb || hasApi) filled += 1;
    else empty += 1;

    const row = {
      id: spec.id,
      label: spec.label,
      suse7_field: spec.suse7_field,
      db_source_table: spec.db_source_table,
      marketplace_field: spec.marketplace_field,
      endpoint: spec.endpoint,
      db_value: dbDisplay,
      api_value: apiDisplay,
      value_type: spec.value_type,
      editable_manual: spec.editable_manual,
      api_only: spec.api_only,
      nature: spec.nature,
      status,
      notes: spec.notes ?? null,
    };

    if (!groupMap[spec.group]) groupMap[spec.group] = { group: spec.group, fields: [] };
    groupMap[spec.group].fields.push(row);
  }

  const groups = Object.values(groupMap);
  const totalFields = specs.length;

  const healthSnap = healthMoneySnapshot(
    ctx.health && typeof ctx.health === "object" ? /** @type {Record<string, unknown>} */ (ctx.health) : null
  );
  const lpSnap = listingPricesRowFeeSnapshot(
    ctx.listingPricesRow && typeof ctx.listingPricesRow === "object"
      ? /** @type {Record<string, unknown>} */ (ctx.listingPricesRow)
      : null
  );

  let netProceedsSerialized = null;
  try {
    if (ctx.listing && typeof ctx.listing === "object") {
      netProceedsSerialized = computeMercadoLivreUnitNetProceeds(
        /** @type {Record<string, unknown>} */ (ctx.listing),
        ctx.health && typeof ctx.health === "object" ? /** @type {Record<string, unknown>} */ (ctx.health) : null,
        ctx.metrics && typeof ctx.metrics === "object" ? /** @type {Record<string, unknown>} */ (ctx.metrics) : null
      );
    }
  } catch (e) {
    netProceedsSerialized = {
      _calculator_error: e instanceof Error ? e.message : String(e),
      has_valid_data: false,
      source: "insufficient_data",
      insufficient_reason: "Exceção ao calcular net_proceeds no inspector.",
    };
  }

  const repasse_e2e = {
    external_listing_id: ctx.listing?.external_listing_id ?? null,
    listing_prices_live: lpSnap,
    health_persisted: healthSnap,
    net_proceeds: netProceedsSerialized
      ? {
          sale_fee_amount: netProceedsSerialized.sale_fee_amount ?? null,
          sale_fee_percent: netProceedsSerialized.sale_fee_percent ?? null,
          shipping_cost_amount: netProceedsSerialized.shipping_cost_amount ?? null,
          net_proceeds_amount: netProceedsSerialized.net_proceeds_amount ?? null,
          has_valid_data: netProceedsSerialized.has_valid_data === true,
          source: netProceedsSerialized.source ?? null,
          insufficient_reason: netProceedsSerialized.insufficient_reason ?? null,
          sale_price: netProceedsSerialized.sale_price ?? null,
          original_price: netProceedsSerialized.original_price ?? null,
        }
      : null,
    diagnosis: buildRepassePipelineDiagnosis({
      lpSnap,
      healthSnap,
      np: netProceedsSerialized,
      tokenAvailable: ctx.tokenAvailable,
    }),
  };

  /** @type {Record<string, number>} */
  const status_counts = {};
  for (const g of groups) {
    for (const f of g.fields) {
      const s = String(f.status || "");
      status_counts[s] = (status_counts[s] || 0) + 1;
    }
  }

  return {
    marketplace: ML_MARKETPLACE_SLUG,
    inspector_version: "1.0",
    listing: ctx.listing
      ? {
          internal_id: ctx.listing.id,
          external_listing_id: ctx.listing.external_listing_id,
          title: ctx.listing.title,
          status: ctx.listing.status,
          sku:
            col(ctx.listing, "seller_custom_field") ??
            col(ctx.listing, "seller_sku") ??
            (ctx.item ? extractSellerSku(/** @type {Record<string, unknown>} */ (ctx.item)) : null),
          last_imported_at: ctx.listing.api_last_seen_at ?? ctx.listing.updated_at ?? null,
          product_id: ctx.listing.product_id ?? null,
        }
      : null,
    summary: {
      total_fields: totalFields,
      filled_db_or_api: filled,
      empty_both: empty,
      unmapped: unmapped,
      api_only_defs: apiOnlyCount,
      calculated_defs: calculated,
      token_available: ctx.tokenAvailable,
      status_counts,
    },
    repasse_e2e,
    groups,
    api_errors: ctx.apiErrors,
    raw_payloads: {
      item: ctx.item,
      listing_prices_row: ctx.listingPricesRow,
      sale_price: ctx.salePrice,
      description: ctx.description,
      marketplace_listing: ctx.listing,
      marketplace_listing_health: ctx.health,
      listing_sales_metrics: ctx.metrics,
      products: ctx.product,
    },
  };
}
