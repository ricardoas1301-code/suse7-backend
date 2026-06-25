/**
 * DASH.6C — valida lucro executivo alinhado ao Raio-X (Decimal.js).
 * Executar: node scripts/test_sale_executive_line_real_result_unit.mjs
 */
import Decimal from "decimal.js";
import { computeExecutiveLineRealProfit } from "../src/domain/sales/saleExecutiveLineRealResult.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Caso homologação MLB6784329822 / SKU 11021 — lucro esperado R$ 19,46
{
  const grossDec = new Decimal("74.99");
  const netDec = new Decimal("46.87"); // repasse marketplace após comissão + frete
  const result = computeExecutiveLineRealProfit({
    product: {
      id: "prod-11021",
      cost_price: "20.00",
      operational_cost: "0.33",
      packaging_cost: "0.33",
    },
    productId: "prod-11021",
    qty: 1,
    grossDec,
    netDec,
    taxProfile: {
      tax_percent: "9.00",
      source: "seller_company_tax_profile",
      seller_company_id: "company-1",
      marketplace_account_id: "account-1",
    },
    pricingFlags: {},
  });

  assert(result.profitDec != null, "Lucro deve ser calculado");
  assert(
    result.profitDec.toFixed(2) === "19.46",
    `Lucro esperado 19.46, obtido ${result.profitDec.toFixed(2)}`,
  );
  assert(
    result.operationPackagingDec != null && result.operationPackagingDec.toFixed(2) === "0.66",
    "Operação + embalagem deve ser 0.66",
  );
}

// ML Ads + custos operacionais (reserva) entram na contingência
{
  const grossDec = new Decimal("100.00");
  const netDec = new Decimal("70.00");
  const result = computeExecutiveLineRealProfit({
    product: {
      id: "prod-2",
      cost_price: "10.00",
      operational_cost: "0.00",
      packaging_cost: "0.00",
    },
    productId: "prod-2",
    qty: 1,
    grossDec,
    netDec,
    taxProfile: {
      tax_percent: "0.00",
      source: "seller_company_tax_profile",
      seller_company_id: "company-1",
      marketplace_account_id: null,
    },
    pricingFlags: {
      ml_ads: { enabled: true, percent: "5.00", amount: null },
      safety_reserve: { enabled: true, percent: "2.00", amount: null },
    },
  });

  assert(result.mlAdsDec != null && result.mlAdsDec.toFixed(2) === "5.00", "ML Ads = 5% de 100");
  assert(result.reserveDec != null && result.reserveDec.toFixed(2) === "2.00", "Reserva = 2% de 100");
  assert(result.profitDec != null && result.profitDec.toFixed(2) === "53.00", "Lucro = 70 - 10 - 5 - 2");
}

console.log("test_sale_executive_line_real_result_unit.mjs — OK");
