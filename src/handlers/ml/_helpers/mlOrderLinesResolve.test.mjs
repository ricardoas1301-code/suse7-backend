import assert from "node:assert/strict";
import test from "node:test";
import { resolveMlOrderLinesFromOrder } from "./mlSalesPersist.js";

test("resolveMlOrderLinesFromOrder: order_items padrão ML", () => {
  const lines = resolveMlOrderLinesFromOrder({
    id: 1,
    order_items: [
      {
        quantity: 1,
        unit_price: 10,
        item: { id: "MLB123", title: "Produto" },
      },
    ],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item.id, "MLB123");
});

test("resolveMlOrderLinesFromOrder: to_be_agreed com order_items (doc ML)", () => {
  const lines = resolveMlOrderLinesFromOrder({
    id: 2000003508419013,
    status: "paid",
    total_amount: 10,
    shipping: { status: "to_be_agreed", id: null },
    order_items: [
      {
        quantity: 1,
        unit_price: 10,
        item: { id: "MLA607850752", title: "Item teste" },
      },
    ],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item.id, "MLA607850752");
});

test("resolveMlOrderLinesFromOrder: elements wrapper", () => {
  const lines = resolveMlOrderLinesFromOrder({
    id: 2,
    order_items: { elements: [{ quantity: 2, unit_price: 5, item: { id: "MLB999" } }] },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item.id, "MLB999");
});

test("resolveMlOrderLinesFromOrder: sintetiza a partir de payments quando order_items vazio", () => {
  const lines = resolveMlOrderLinesFromOrder({
    id: 3,
    total_amount: 266.91,
    currency_id: "BRL",
    payments: [
      {
        status: "approved",
        reason: "Tabua Mesa De Passar",
        transaction_amount: 266.91,
      },
    ],
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].unit_price, 266.91);
  assert.equal(lines[0].item.title, "Tabua Mesa De Passar");
  assert.equal(lines[0]._s7_synthesized?.source, "order_shell");
});

test("resolveMlOrderLinesFromOrder: raw_json aninhado em sales_orders", () => {
  const lines = resolveMlOrderLinesFromOrder({
    id: 4,
    raw_json: {
      order_items: [{ quantity: 1, unit_price: 99, item: { id: "MLB555" } }],
    },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].item.id, "MLB555");
});
