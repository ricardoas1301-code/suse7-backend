#!/usr/bin/env node
/**
 * CPJ2 T9 — ordenação canônica da lista de Vendas (data da venda, não ingestão).
 */
import assert from "node:assert/strict";
import {
  collectOrdersByIdFromEmbeddedItems,
  paginateVendasItemsCanonical,
  sortSalesOrderItemsForVendasList,
} from "../src/domain/sales/vendasListCanonicalOrder.js";

const recent = {
  id: "item-recent",
  sales_order_id: "ord-recent",
  created_at: "2026-09-10T12:00:00.000Z",
};
const historicalLateIngest = {
  id: "item-hist",
  sales_order_id: "ord-hist",
  created_at: "2026-09-10T20:50:46.967Z",
};
const olderRecent = {
  id: "item-older-recent",
  sales_order_id: "ord-older-recent",
  created_at: "2026-09-10T18:19:13.368Z",
};
const orders = new Map([
  [
    "ord-recent",
    { date_created_marketplace: "2026-09-11T08:52:03+00:00", created_at: "2026-09-11T08:52:11.668Z" },
  ],
  [
    "ord-hist",
    { date_created_marketplace: "2026-09-07T18:33:00+00:00", created_at: "2026-09-10T20:50:46.967Z" },
  ],
  [
    "ord-older-recent",
    { date_created_marketplace: "2026-09-10T18:17:34+00:00", created_at: "2026-09-10T18:19:13.368Z" },
  ],
]);

const ingestPoisoned = [historicalLateIngest, olderRecent, recent];
const page1 = paginateVendasItemsCanonical(ingestPoisoned, orders, 0, 2);
assert.equal(page1.total, 3);
assert.equal(page1.pageItems[0].id, "item-recent", "primeira linha = data real da venda, não ingestão");
assert.equal(page1.pageItems[1].id, "item-older-recent");
assert.equal(
  page1.pageItems.some((r) => r.id === "item-hist"),
  false,
  "histórico recém-ingerido não ocupa a primeira página de page_size=2",
);
const page2 = paginateVendasItemsCanonical(ingestPoisoned, orders, 2, 2);
assert.equal(page2.pageItems[0].id, "item-hist");
assert.equal(page1.pageItems.map((r) => r.id).join(), "item-recent,item-older-recent");
assert.notEqual(page1.pageItems[0].id, page2.pageItems[0].id, "sem duplicar entre páginas");
console.log("T9_RECENT_PLUS_HISTORICAL_INGEST=PASS");

const sameTsOrders = new Map([
  ["a", { date_created_marketplace: "2026-09-10T12:00:00.000Z", created_at: "2026-09-10T12:00:01.000Z" }],
  ["b", { date_created_marketplace: "2026-09-10T12:00:00.000Z", created_at: "2026-09-10T12:00:01.000Z" }],
]);
const sameTsItems = [
  { id: "aaa-id", sales_order_id: "a", created_at: "2026-09-10T12:00:02.000Z" },
  { id: "zzz-id", sales_order_id: "b", created_at: "2026-09-10T12:00:02.000Z" },
];
const first = paginateVendasItemsCanonical(sameTsItems, sameTsOrders, 0, 10).pageItems.map((r) => r.id);
const second = paginateVendasItemsCanonical(sameTsItems.slice().reverse(), sameTsOrders, 0, 10).pageItems.map(
  (r) => r.id,
);
assert.deepEqual(first, second, "desempate por id é determinístico");
assert.deepEqual(first, ["zzz-id", "aaa-id"]);
console.log("T9_STABLE_TIE_BREAK=PASS");

const brtVsUtc = new Map([
  ["brt", { date_created_marketplace: "2026-09-10T15:00:00-03:00", created_at: "2026-09-10T18:00:00.000Z" }],
  ["utc", { date_created_marketplace: "2026-09-10T17:00:00.000Z", created_at: "2026-09-10T17:00:01.000Z" }],
]);
const tzItems = [
  { id: "brt-row", sales_order_id: "brt", created_at: "2026-09-11T00:00:00.000Z" },
  { id: "utc-row", sales_order_id: "utc", created_at: "2026-09-10T17:00:02.000Z" },
];
sortSalesOrderItemsForVendasList(tzItems, brtVsUtc);
assert.equal(tzItems[0].id, "brt-row", "15:00 BRT = 18:00 UTC, mais recente que 17:00 UTC");
console.log("T9_TIMEZONE_BRT=PASS");

const embedded = [
  {
    id: "e1",
    sales_order_id: "ord-1",
    created_at: "2026-09-10T20:00:00.000Z",
    sales_orders: { date_created_marketplace: "2026-01-01T00:00:00.000Z", created_at: "2026-09-10T20:00:00.000Z" },
  },
  {
    id: "e2",
    sales_order_id: "ord-2",
    created_at: "2026-09-01T00:00:00.000Z",
    sales_orders: { date_created_marketplace: "2026-09-11T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z" },
  },
];
const fromEmbed = collectOrdersByIdFromEmbeddedItems(embedded);
const p = paginateVendasItemsCanonical(embedded, fromEmbed, 0, 10);
assert.equal(p.pageItems[0].id, "e2");
assert.equal(p.pageItems[1].id, "e1");
console.log("T9_EMBEDDED_ORDER_MAP=PASS");

const empty = paginateVendasItemsCanonical([], new Map(), 0, 50);
assert.equal(empty.total, 0);
assert.deepEqual(empty.pageItems, []);
console.log("T9_EMPTY=PASS");

console.log("CPJ2_T9_VENDAS_LIST_CANONICAL_ORDER=PASS");
