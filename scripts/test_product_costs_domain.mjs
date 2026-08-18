/**
 * Regressão — domínio de custos de produto (batch + SSOT).
 * Executar: node scripts/test_product_costs_domain.mjs
 */

import {
  validateProductCostsPayload,
  isProductCostsIncomplete,
  parseMoneyDecimalString,
  persistProductCostsForUser,
} from "../src/domain/products/persistProductCosts.js";
import { hasRequiredProductCosts } from "../src/domain/productCatalogCompleteness.js";
import { handleProductsCostsBatchSave } from "../src/handlers/products/costsBatchSave.js";
import { handleProductsCostsPendingList } from "../src/handlers/products/costsPendingList.js";

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.error(`✗ ${name}`);
  }
}

assert("handler POST /costs/batch possui cadeia de imports íntegra", typeof handleProductsCostsBatchSave === "function");
assert("handler GET /costs/pending possui cadeia de imports íntegra", typeof handleProductsCostsPendingList === "function");
assert("custo completo aceita embalagem 0", hasRequiredProductCosts("59.00", "0.00", "4.00"));
assert("custo incompleto sem embalagem", isProductCostsIncomplete("59.00", null, "4.00"));
assert("custo incompleto produto zero", isProductCostsIncomplete("0.00", "2.00", "1.00"));
assert("parse decimal preserva centavos", parseMoneyDecimalString("1234.56").value === "1234.56");
assert("parse decimal normaliza décimo sem float", parseMoneyDecimalString("0.10").value === "0.10");
assert("parse decimal BR aceita vírgula", parseMoneyDecimalString("19,99").value === "19.99");
assert("zero é válido para custos acessórios", parseMoneyDecimalString("0,00").value === "0.00");

const valid = validateProductCostsPayload({
  cost_price: "59.99",
  packaging_cost: "0.00",
  operational_cost: "4.01",
});
assert(
  "payload válido mantém strings decimais",
  valid.ok === true &&
    valid.costs.cost_price === "59.99" &&
    valid.costs.packaging_cost === "0.00" &&
    valid.costs.operational_cost === "4.01"
);

const invalid = validateProductCostsPayload({
  cost_price: "0.00",
  packaging_cost: "0.00",
  operational_cost: "4.00",
});
assert("rejeita custo do produto zero", invalid.ok === false);

function createSupabaseFake(existingProduct) {
  const state = {
    productUpdate: null,
    productUpdateFilters: {},
    listingUpdate: null,
    listingUpdateFilters: {},
  };

  return {
    state,
    from(table) {
      if (table === "products") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        return { data: existingProduct, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
          update(payload) {
            state.productUpdate = payload;
            return {
              eq(column, value) {
                state.productUpdateFilters[column] = value;
                return {
                  async eq(secondColumn, secondValue) {
                    state.productUpdateFilters[secondColumn] = secondValue;
                    return { error: null };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "marketplace_listings") {
        return {
          update(payload) {
            state.listingUpdate = payload;
            return {
              eq(column, value) {
                state.listingUpdateFilters[column] = value;
                return {
                  async eq(secondColumn, secondValue) {
                    state.listingUpdateFilters[secondColumn] = secondValue;
                    return { error: null };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Tabela inesperada no teste: ${table}`);
    },
  };
}

const productId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const fake = createSupabaseFake({
  id: productId,
  user_id: userId,
  catalog_source: "manual",
  cost_price: null,
  packaging_cost: null,
  operational_cost: null,
});
const persisted = await persistProductCostsForUser({
  supabase: fake,
  userId,
  productId,
  costs: valid.costs,
});
assert("persistência canônica conclui", persisted.ok === true);
assert(
  "persistência envia strings decimais ao banco",
  fake.state.productUpdate.cost_price === "59.99" &&
    fake.state.productUpdate.packaging_cost === "0.00" &&
    fake.state.productUpdate.operational_cost === "4.01"
);
assert(
  "update permanece escopado por produto e usuário",
  fake.state.productUpdateFilters.id === productId &&
    fake.state.productUpdateFilters.user_id === userId
);
assert(
  "propagação para anúncios permanece escopada por produto e usuário",
  fake.state.listingUpdateFilters.product_id === productId &&
    fake.state.listingUpdateFilters.user_id === userId
);

const foreignFake = createSupabaseFake(null);
const foreignAttempt = await persistProductCostsForUser({
  supabase: foreignFake,
  userId,
  productId,
  costs: valid.costs,
});
assert("produto fora do tenant retorna not found", foreignAttempt.code === "PRODUCT_NOT_FOUND");
assert("produto fora do tenant não executa update", foreignFake.state.productUpdate === null);

console.log(`\nResultado: ${passed} ok, ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
