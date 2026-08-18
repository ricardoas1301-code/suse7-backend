import assert from "node:assert/strict";
import {
  countSkuDependencyPendingForUser,
  listSkuDependencyPendingForUser,
  projectSkuDependencyPending,
} from "../src/domain/listings/skuDependencyPending.js";
import {
  buildOperationalTasksPayload,
} from "../src/domain/dashboard/operationalTasksPayload.js";
import {
  executeBulkSetSku,
  executeBulkSetSkuV2,
} from "../src/handlers/listings/bulkSetSkuService.js";
import { batchEnsureProductsForListings } from "../src/handlers/ml/_helpers/mlListingProductLink.js";

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.mutation = null;
    this.options = {};
  }
  select(columns, options = {}) {
    this.columns = columns;
    this.options = options;
    return this;
  }
  eq(column, value) {
    this.filters.push((row) => String(row[column]) === String(value));
    return this;
  }
  in(column, values) {
    const set = new Set((values || []).map(String));
    this.filters.push((row) => set.has(String(row[column])));
    return this;
  }
  is(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  or() { return this; }
  order() { return this; }
  range() { return this; }
  limit() { return this; }
  update(payload) {
    this.mutation = { type: "update", payload };
    return this;
  }
  insert(payload) {
    this.mutation = { type: "insert", payload };
    return this;
  }
  delete() {
    this.mutation = { type: "delete" };
    return this;
  }
  maybeSingle() {
    return this.run().then(({ data, error }) => ({
      data: Array.isArray(data) ? data[0] || null : data,
      error,
    }));
  }
  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }
  async run() {
    const rows = this.db.tables[this.table] || (this.db.tables[this.table] = []);
    const matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.mutation?.type === "update") {
      for (const row of matched) Object.assign(row, structuredClone(this.mutation.payload));
      return { data: this.columns ? matched.map((row) => ({ ...row })) : null, error: null };
    }
    if (this.mutation?.type === "insert") {
      const inputs = Array.isArray(this.mutation.payload)
        ? this.mutation.payload
        : [this.mutation.payload];
      const inserted = inputs.map((input) => {
        const row = structuredClone(input);
        if (!row.id) row.id = `created-${++this.db.sequence}`;
        if (this.table === "products" && !row.normalized_sku) {
          row.normalized_sku = String(row.sku || "").trim().toUpperCase();
        }
        rows.push(row);
        return row;
      });
      return { data: this.columns ? inserted : null, error: null };
    }
    if (this.mutation?.type === "delete") {
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      return { data: null, error: null };
    }
    return {
      data: this.options.head ? null : matched.map((row) => ({ ...row })),
      count: this.options.count === "exact" ? matched.length : null,
      error: null,
    };
  }
}

class SupabaseMock {
  constructor(tables) {
    this.tables = structuredClone(tables);
    this.sequence = 0;
  }
  from(table) { return new Query(this, table); }
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const baseTables = () => ({
  marketplace_listings: [
    { id: A, user_id: "seller-a", marketplace: "mercado_livre", external_listing_id: "MLB1", title: "A", raw_json: {}, product_id: null, attention_reason: "sku_pending_ml" },
    { id: B, user_id: "seller-a", marketplace: "mercado_livre", external_listing_id: "MLB2", title: "B", raw_json: {}, product_id: null, attention_reason: null },
    { id: FOREIGN, user_id: "seller-b", marketplace: "mercado_livre", external_listing_id: "MLB3", title: "X", raw_json: {}, product_id: null, attention_reason: null },
  ],
  products: [
    { id: "p-a", user_id: "seller-a", sku: "SKU-A", normalized_sku: "SKU-A", catalog_completeness: "complete", completion_status: "complete", missing_required_costs: false, product_name: "Produto A" },
    { id: "p-b", user_id: "seller-a", sku: "SKU-B", normalized_sku: "SKU-B", catalog_completeness: "complete", completion_status: "complete", missing_required_costs: false, product_name: "Produto B" },
  ],
  product_variants: [],
  competition_monitored_listings: [],
  marketplace_listing_change_events: [],
  marketplace_listing_health: [],
  marketplace_listing_descriptions: [],
  product_image_links: [],
});

assert.deepEqual(projectSkuDependencyPending({ product_id: null, attention_reason: "sku_pending_ml", status: "closed" }), {
  sku_dependency_pending: true,
  sku_dependency_reason: "ml_missing_sku",
});
assert.deepEqual(projectSkuDependencyPending({ product_id: null, attention_reason: "other", status: "paused" }), {
  sku_dependency_pending: true,
  sku_dependency_reason: "product_link_missing",
});
assert.deepEqual(projectSkuDependencyPending({ product_id: "p-a", attention_reason: "sku_pending_ml" }), {
  sku_dependency_pending: false,
  sku_dependency_reason: null,
});

const countDb = new SupabaseMock(baseTables());
assert.equal(await countSkuDependencyPendingForUser(countDb, "seller-a"), 2);
assert.equal(await countSkuDependencyPendingForUser(countDb, "seller-b"), 1);
countDb.tables.marketplace_listings[0].status = "closed";
const pendingList = await listSkuDependencyPendingForUser(countDb, "seller-a", {
  page: 1,
  pageSize: 10,
  q: "MLB",
});
assert.equal(pendingList.total, 2);
assert.deepEqual(pendingList.items.map((item) => item.reason), [
  "ml_missing_sku",
  "product_link_missing",
]);
assert.equal(pendingList.items[0].listing_id, pendingList.items[0].id);
assert.equal(pendingList.items[0].image, pendingList.items[0].image_url);
assert.equal(pendingList.items[0].canal, "mercado_livre");

const tasks = buildOperationalTasksPayload({
  skuDependencyPendingCount: 2,
  missingProductCostsCount: 3,
});
assert.deepEqual(tasks.tasks.map((task) => [task.id, task.sort_order, task.action.type]), [
  ["sku_dependency_pending", 5, "open_bulk_listing_skus"],
  ["missing_product_costs", 10, "open_bulk_product_costs"],
]);
assert.equal(tasks.tasks[0].action.label, "Cadastrar SKUs");
assert.equal(tasks.tasks[0].description, "2 anúncios aguardam cadastro ou vínculo de SKU");

{
  const db = new SupabaseMock(baseTables());
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [{ listing_id: A, sku: "SKU-A" }],
  });
  assert.equal(result.total_succeeded, 1, "v2 1 item");
  assert.equal(result.total_updated, 1);
  assert.equal(result.total_skipped, 0);
  assert.equal(result.results[0].status, "SUCCESS");
  assert.equal(db.tables.marketplace_listings[0].product_id, "p-a");
  assert.equal(db.tables.marketplace_listings[0].raw_json.seller_sku, "SKU-A");
}

{
  const db = new SupabaseMock(baseTables());
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [{ listing_id: "" }, { listing_id: A, sku: "" }],
  });
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["VALIDATION_ERROR", "VALIDATION_ERROR"],
  );
  assert.equal(result.total_updated, 0);
  assert.equal(result.total_skipped, 2);
}

{
  const db = new SupabaseMock(baseTables());
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [
      { listing_id: A, sku: "SKU-A" },
      { listing_id: "MLB1", sku: "sku-a" },
      { listing_id: B, sku: "SKU-A" },
    ],
  });
  assert.equal(result.total_succeeded, 3, "v2 N e mesmo SKU em anúncios distintos");
  assert.equal(result.results[1].deduplicated, true, "token duplicado dedupado após resolução");
  assert.equal(db.tables.marketplace_listings[1].product_id, "p-a");
}

{
  const db = new SupabaseMock(baseTables());
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [
      { listing_id: A, sku: "SKU-A" },
      { listing_id: "MLB1", sku: "SKU-B" },
    ],
  });
  assert.deepEqual(result.results.map((entry) => entry.code), ["CONFLICT", "CONFLICT"]);
  assert.deepEqual(result.results.map((entry) => entry.status), ["CONFLICT", "CONFLICT"]);
  assert.equal(db.tables.marketplace_listings[0].product_id, null);
}

{
  const db = new SupabaseMock(baseTables());
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [
      { listing_id: A, sku: "SKU-A" },
      { listing_id: FOREIGN, sku: "SKU-B" },
    ],
  });
  assert.equal(result.partial_success, true);
  assert.equal(result.total_succeeded, 1);
  assert.equal(result.total_updated, 1);
  assert.equal(result.total_skipped, 1);
  assert.equal(result.results[1].code, "NOT_FOUND_OR_DENIED");
  assert.equal(result.results[1].status, "NOT_FOUND");
  assert.equal(result.errors.length, 1);
}

{
  const tables = baseTables();
  tables.marketplace_listings[0].seller_sku = "SKU-NOVO";
  const db = new SupabaseMock(tables);
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [{ listing_id: A }],
  });
  assert.equal(result.total_succeeded, 1, "SKU já existente no anúncio é reaproveitado");
  assert.equal(result.results[0].product_created, true, "SKU sem correspondência cria produto");
  assert.equal(db.tables.marketplace_listings[0].product_id, "created-1");
}

{
  const tables = baseTables();
  tables.marketplace_listings[0].seller_sku = "SKU-NOVO-A";
  tables.marketplace_listings[1].seller_sku = "SKU-NOVO-B";
  const db = new SupabaseMock(tables);
  let batchCalls = 0;
  let batchEntries = 0;
  const result = await executeBulkSetSkuV2({
    supabase: db,
    userId: "seller-a",
    items: [{ listing_id: A }, { listing_id: B }],
    batchEnsureProductsForListingsFn: async (...args) => {
      batchCalls += 1;
      batchEntries = args[2].length;
      return batchEnsureProductsForListings(...args);
    },
  });
  assert.equal(batchCalls, 1, "v2 chama batchEnsure uma única vez");
  assert.equal(batchEntries, 2, "batch canônico recebe todos os SKUs sem produto");
  assert.equal(result.total_updated, 2);
  assert.deepEqual(result.results.map((entry) => entry.status), ["SUCCESS", "SUCCESS"]);
}

{
  const tables = baseTables();
  tables.products.push({
    ...tables.products[0],
    id: "p-a-duplicado",
  });
  const dbConflict = new SupabaseMock(tables);
  const conflict = await executeBulkSetSkuV2({
    supabase: dbConflict,
    userId: "seller-a",
    items: [{ listing_id: A, sku: "SKU-A" }],
  });
  assert.equal(conflict.results[0].code, "CONFLICT", "ambiguidade não escolhe produto arbitrariamente");

  const dbSelected = new SupabaseMock(tables);
  const selected = await executeBulkSetSkuV2({
    supabase: dbSelected,
    userId: "seller-a",
    items: [{ listing_id: A, sku: "SKU-A", selected_product_id: "p-a" }],
  });
  assert.equal(selected.total_succeeded, 1, "selected_product_id resolve ambiguidade");
  assert.equal(dbSelected.tables.marketplace_listings[0].product_id, "p-a");
}

{
  const db = new SupabaseMock(baseTables());
  const result = await executeBulkSetSku({
    supabase: db,
    userId: "seller-a",
    canonicalMarketplace: "mercado_livre",
    skuRaw: "SKU-A",
    listingTokens: [A, B],
  });
  assert.equal(result.status, 200, "v1 permanece funcional");
  assert.equal(result.body.total_updated, 2);
  assert.equal(result.body.normalized_sku, "SKU-A");
  assert.deepEqual(Object.keys(result.body).sort(), [
    "errors",
    "normalized_sku",
    "ok",
    "product_id",
    "sku_literal",
    "total_received",
    "total_skipped",
    "total_updated",
  ]);
}

console.log("[test_sku_dependency_backend_unit] OK");
