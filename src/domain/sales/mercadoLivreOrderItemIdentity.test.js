/**
 * Identidade canônica ML order_items.
 * node --test src/domain/sales/mercadoLivreOrderItemIdentity.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMercadoLivreOrderItemIdentity,
  buildMercadoLivreOrderItemOccurrenceKey,
} from "./mercadoLivreOrderItemIdentity.js";

const ORDER_A = "2000017853920222";
const ORDER_B = "2000017561767306";

describe("resolveMercadoLivreOrderItemIdentity", () => {
  it("usa line.id oficial quando presente", () => {
    const line = {
      id: "OI-999",
      quantity: 1,
      item: { id: "MLB6086959274", seller_custom_field: "11011" },
    };
    const identity = resolveMercadoLivreOrderItemIdentity(line, {
      externalOrderId: ORDER_A,
      lineIndex: 0,
      linesInOrder: [line],
    });
    assert.equal(identity.external_order_item_id, "OI-999");
    assert.equal(identity.identity_source, "official_line_id");
    assert.equal("external_item_id" in identity, false);
  });

  it("gera identidade sintética determinística quando line.id ausente (case RF)", () => {
    const line = {
      quantity: 1,
      unit_price: 266.05,
      item: { id: "MLB6086959274", seller_custom_field: "11011" },
    };
    const a = resolveMercadoLivreOrderItemIdentity(line, {
      externalOrderId: ORDER_A,
      lineIndex: 0,
      linesInOrder: [line],
    });
    const b = resolveMercadoLivreOrderItemIdentity(line, {
      externalOrderId: ORDER_A,
      lineIndex: 0,
      linesInOrder: [line],
    });
    assert.equal(a.external_order_item_id, b.external_order_item_id);
    assert.match(a.external_order_item_id, /^ml:2000017853920222:MLB6086959274:0:11011:0$/);
    assert.equal(a.identity_source, "synthetic");
  });

  it("duas variações legítimas => identidades distintas", () => {
    const lineA = { item: { id: "MLB1", variation_id: "111" }, quantity: 1 };
    const lineB = { item: { id: "MLB1", variation_id: "222" }, quantity: 1 };
    const idA = resolveMercadoLivreOrderItemIdentity(lineA, {
      externalOrderId: ORDER_B,
      lineIndex: 0,
      linesInOrder: [lineA, lineB],
    }).external_order_item_id;
    const idB = resolveMercadoLivreOrderItemIdentity(lineB, {
      externalOrderId: ORDER_B,
      lineIndex: 1,
      linesInOrder: [lineA, lineB],
    }).external_order_item_id;
    assert.notEqual(idA, idB);
  });

  it("duas linhas equivalentes sem line.id => occurrence 0 e 1", () => {
    const line0 = { item: { id: "MLB1", seller_custom_field: "SKU" }, quantity: 1 };
    const line1 = { item: { id: "MLB1", seller_custom_field: "SKU" }, quantity: 1 };
    const lines = [line0, line1];
    const id0 = resolveMercadoLivreOrderItemIdentity(line0, {
      externalOrderId: ORDER_B,
      lineIndex: 0,
      linesInOrder: lines,
    }).external_order_item_id;
    const id1 = resolveMercadoLivreOrderItemIdentity(line1, {
      externalOrderId: ORDER_B,
      lineIndex: 1,
      linesInOrder: lines,
    }).external_order_item_id;
    assert.notEqual(id0, id1);
    assert.match(id0, /:0$/);
    assert.match(id1, /:1$/);
  });

  it("occurrence key não usa valores financeiros", () => {
    const line = { unit_price: 999, gross_amount: 888, item: { id: "MLB9" } };
    const key = buildMercadoLivreOrderItemOccurrenceKey(line);
    assert.equal(key.includes("999"), false);
    assert.equal(key.includes("888"), false);
  });
});
