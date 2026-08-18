import assert from "node:assert/strict";
import {
  buildMissingRequiredProductCostsPostgrestOrFilter,
  hasRequiredProductCosts,
} from "../src/domain/productCatalogCompleteness.js";
import { countMissingProductCostsForUser } from "../src/domain/dashboard/operationalTasksPayload.js";

const cases = [
  { name: "cost_price null", values: [null, 0, 0], complete: false },
  { name: "cost_price zero", values: [0, 0, 0], complete: false },
  { name: "packaging_cost null", values: ["10.50", null, 0], complete: false },
  { name: "packaging_cost zero", values: ["10.50", 0, 0], complete: true },
  { name: "operational_cost null", values: ["10.50", 0, null], complete: false },
  { name: "operational_cost zero", values: ["10.50", 0, 0], complete: true },
  { name: "todos os custos completos", values: ["10.50", "2.25", "1.10"], complete: true },
];

for (const testCase of cases) {
  assert.equal(
    hasRequiredProductCosts(...testCase.values),
    testCase.complete,
    testCase.name,
  );
}

const importedMarketplaceProduct = {
  catalog_completeness: "draft_imported_from_marketplace",
  cost_price: null,
  packaging_cost: null,
  operational_cost: null,
};
assert.equal(
  hasRequiredProductCosts(
    importedMarketplaceProduct.cost_price,
    importedMarketplaceProduct.packaging_cost,
    importedMarketplaceProduct.operational_cost,
  ),
  false,
  "produto importado com custos incompletos permanece pendente",
);

const expectedFilter = [
  "cost_price.is.null",
  "cost_price.lte.0",
  "packaging_cost.is.null",
  "packaging_cost.lt.0",
  "operational_cost.is.null",
  "operational_cost.lt.0",
].join(",");
assert.equal(buildMissingRequiredProductCostsPostgrestOrFilter(), expectedFilter);
assert.doesNotMatch(expectedFilter, /catalog_completeness|missing_required_costs|completion_status/);

function createSupabaseMock(countByUserId) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(["from", table]);
      return {
        select(columns, options) {
          calls.push(["select", columns, options]);
          return {
            eq(column, value) {
              calls.push(["eq", column, value]);
              return {
                async or(filter) {
                  calls.push(["or", filter]);
                  return { count: countByUserId[value] ?? 0, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

const supabase = createSupabaseMock({
  "seller-a": 143,
  "seller-b": 0,
});
assert.equal(await countMissingProductCostsForUser(supabase, "seller-a"), 143);
assert.equal(await countMissingProductCostsForUser(supabase, "seller-b"), 0);

const tenantCalls = supabase.calls.filter(([method]) => method === "eq");
assert.deepEqual(tenantCalls, [
  ["eq", "user_id", "seller-a"],
  ["eq", "user_id", "seller-b"],
]);
assert.equal(
  supabase.calls.filter(([method, value]) => method === "from" && value === "products").length,
  2,
);
assert.equal(
  supabase.calls.filter(([method, value]) => method === "or" && value === expectedFilter).length,
  2,
);

const noUserSupabase = createSupabaseMock({});
assert.equal(await countMissingProductCostsForUser(noUserSupabase, ""), 0);
assert.equal(noUserSupabase.calls.length, 0);

console.log("[test_operational_tasks_product_costs_ssot_unit] OK");
