/**
 * Concorrência idempotente — sales_order_items UPSERT canônico.
 * node --test src/handlers/ml/_helpers/salesOrderItemsConcurrentPersist.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mapMlOrderItemToRow } from "./mlSalesPersist.js";
import {
  persistSalesOrderItemsCanonicalUpsert,
  SALES_ORDER_ITEMS_CANONICAL_UPSERT_CONFLICT,
} from "./salesOrderItemsCanonicalPersist.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";

/** @param {string} salesOrderId */
function createInMemoryItemsSupabase(salesOrderId) {
  /** @type {Map<string, Record<string, unknown>>} */
  const byCanonical = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();

  const canonicalKey = (row) =>
    `${row.marketplace}|${row.marketplace_account_id}|${row.external_order_id}|${row.external_order_item_id}`;

  return {
    injectLegacyRow(row) {
      const id = row.id != null ? String(row.id) : crypto.randomUUID();
      const stored = { ...row, id, sales_order_id: salesOrderId };
      byId.set(id, stored);
      if (row.external_order_item_id != null && String(row.external_order_item_id).trim() !== "") {
        byCanonical.set(canonicalKey(stored), stored);
      }
    },
    from(table) {
      assert.equal(table, "sales_order_items");
      const state = {
        filters: /** @type {Record<string, unknown>} */ ({}),
        pendingIds: /** @type {string[] | null} */ (null),
      };

      const api = {
        upsert(rows, opts) {
          assert.equal(opts.onConflict, SALES_ORDER_ITEMS_CANONICAL_UPSERT_CONFLICT);
          for (const row of rows) {
            const key = canonicalKey(row);
            const existing = byCanonical.get(key);
            const id = existing?.id ?? crypto.randomUUID();
            const stored = { ...row, id, sales_order_id: salesOrderId };
            byCanonical.set(key, stored);
            byId.set(String(id), stored);
          }
          return Promise.resolve({ error: null });
        },
        select(_cols) {
          return api;
        },
        eq(col, val) {
          state.filters[col] = val;
          return api;
        },
        in(col, ids) {
          if (col === "id") state.pendingIds = ids.map(String);
          return api;
        },
        delete() {
          return {
            eq(col, val) {
              if (col === "sales_order_id") {
                for (const [id, row] of [...byId.entries()]) {
                  if (String(row.sales_order_id) === String(val)) {
                    byId.delete(id);
                    byCanonical.delete(canonicalKey(row));
                  }
                }
              }
              return Promise.resolve({ error: null });
            },
            in(col, ids) {
              assert.equal(col, "id");
              for (const id of ids) {
                const row = byId.get(String(id));
                if (row) {
                  byId.delete(String(id));
                  byCanonical.delete(canonicalKey(row));
                }
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        then(resolve, reject) {
          try {
            let rows = [...byId.values()];
            if (state.filters.sales_order_id != null) {
              rows = rows.filter((r) => String(r.sales_order_id) === String(state.filters.sales_order_id));
            }
            if (state.pendingIds) {
              const set = new Set(state.pendingIds);
              rows = rows.filter((r) => set.has(String(r.id)));
            }
            resolve({ data: rows, error: null });
          } catch (err) {
            reject(err);
          }
        },
      };
      return api;
    },
    countRows() {
      return [...byId.values()].filter((r) => String(r.sales_order_id) === salesOrderId).length;
    },
  };
}

function buildSampleOrderLines(externalOrderId) {
  return [
    {
      quantity: 1,
      unit_price: 266.05,
      sale_fee: 35.92,
      shipping_cost_share: 49.35,
      item: { id: "MLB6086959274", seller_custom_field: "11011", title: "Produto teste" },
    },
  ];
}

function buildRows(externalOrderId, salesOrderId, userId, accountId) {
  const lines = buildSampleOrderLines(externalOrderId);
  const nowIso = new Date().toISOString();
  return lines.map((line, lineIndex) =>
    mapMlOrderItemToRow(
      userId,
      ML_MARKETPLACE_SLUG,
      salesOrderId,
      line,
      nowIso,
      accountId,
      null,
      externalOrderId,
      { lineIndex, linesInOrder: lines },
    ),
  );
}

describe("persistSalesOrderItemsCanonicalUpsert — concorrência", () => {
  const salesOrderId = "a84155cd-f6f2-4264-8950-3b8297022d08";
  const userId = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
  const accountId = "be36ef3e-cd3b-4b94-b071-4eb583ee4fce";
  const externalOrderId = "2000017853920222";

  it("2 persistências concorrentes => 1 linha canônica", async () => {
    const sb = createInMemoryItemsSupabase(salesOrderId);
    const rows = buildRows(externalOrderId, salesOrderId, userId, accountId);
    await Promise.all([
      persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows),
      persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows),
    ]);
    assert.equal(sb.countRows(), 1);
  });

  it("10 persistências concorrentes => 1 linha canônica", async () => {
    const sb = createInMemoryItemsSupabase(salesOrderId);
    const rows = buildRows(externalOrderId, salesOrderId, userId, accountId);
    await Promise.all(
      Array.from({ length: 10 }, () => persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows)),
    );
    assert.equal(sb.countRows(), 1);
  });

  it("pack/multi-item legítimo => N linhas distintas", async () => {
    const sb = createInMemoryItemsSupabase("pack-order-id");
    const lines = [
      { id: "L1", quantity: 1, unit_price: 100, item: { id: "MLB_A" } },
      { id: "L2", quantity: 1, unit_price: 200, item: { id: "MLB_B" } },
    ];
    const nowIso = new Date().toISOString();
    const rows = lines.map((line, lineIndex) =>
      mapMlOrderItemToRow(
        userId,
        ML_MARKETPLACE_SLUG,
        "pack-order-id",
        line,
        nowIso,
        accountId,
        null,
        "PACK-ORDER-1",
        { lineIndex, linesInOrder: lines },
      ),
    );
    await persistSalesOrderItemsCanonicalUpsert(sb, "pack-order-id", rows);
    assert.equal(sb.countRows(), 2);
  });

  it("reprocessamento sequencial remove órfãos legacy NULL", async () => {
    const sb = createInMemoryItemsSupabase(salesOrderId);
    sb.injectLegacyRow({
      sales_order_id: salesOrderId,
      user_id: userId,
      marketplace: ML_MARKETPLACE_SLUG,
      marketplace_account_id: accountId,
      external_order_id: externalOrderId,
      external_order_item_id: null,
      external_listing_id: "MLB6086959274",
      gross_amount: 266.05,
      quantity: 1,
    });
    assert.equal(sb.countRows(), 1);
    const rows = buildRows(externalOrderId, salesOrderId, userId, accountId);
    await persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows);
    assert.equal(sb.countRows(), 1);
  });
});

describe("event-first / retry — mesma identidade", () => {
  it("webhook + recovery com mesmo payload => 1 linha", async () => {
    const salesOrderId = "retry-order";
    const sb = createInMemoryItemsSupabase(salesOrderId);
    const rows = buildRows("2000017561767306", salesOrderId, "user-1", "acc-1");
    await persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows);
    await persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows);
    await persistSalesOrderItemsCanonicalUpsert(sb, salesOrderId, rows);
    assert.equal(sb.countRows(), 1);
  });
});
