// ======================================================================
// Testes unitários — S1.PROMO-CALC-CARDS-LOADING-AND-SPACING-POLISH
// ======================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_CSS_PATH = join(
  __dirname,
  "../../suse7-frontend/src/components/pricing/PricingIntelligencePromotionsPanel.css",
);

async function testChaveFinanceiraMudaComPromocao() {
  const { montarChaveCenarioFinanceiroPromocao } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionFinancialScenarioKey.js"
  );

  const base = {
    listingExternalId: "MLB6086602390",
    listingType: "classic",
    precoPromocao: 261.8,
    configuracaoFinanceira: { mlAdsEnabled: true, mlAdsPercent: "10" },
  };

  const keyA = montarChaveCenarioFinanceiroPromocao({
    ...base,
    promotionSelection: { promotion_id: "P-A" },
  });
  const keyB = montarChaveCenarioFinanceiroPromocao({
    ...base,
    promotionSelection: { promotion_id: "P-B" },
  });

  assert.ok(keyA != null);
  assert.ok(keyB != null);
  assert.notEqual(keyA, keyB);
}

async function testPendenteQuandoChaveDivergeOuLoading() {
  const { resolverCenarioFinanceiroPromocaoPendente } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionFinancialScenarioKey.js"
  );

  assert.equal(
    resolverCenarioFinanceiroPromocaoPendente({
      selectedKey: "k-new",
      renderedKey: "k-old",
      loading: false,
    }),
    true,
  );

  assert.equal(
    resolverCenarioFinanceiroPromocaoPendente({
      selectedKey: "k-new",
      renderedKey: "k-new",
      loading: true,
    }),
    true,
  );

  assert.equal(
    resolverCenarioFinanceiroPromocaoPendente({
      selectedKey: "k-new",
      renderedKey: "k-new",
      loading: false,
    }),
    false,
  );
}

async function testCssRespiroReceitaPromocoes() {
  const css = readFileSync(PANEL_CSS_PATH, "utf8");
  assert.match(css, /anuncios-sell-popover__section--receita-pi-promo/);
  assert.match(css, /margin-bottom:\s*10px/);
}

async function testMetricValueComponenteExiste() {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    join(dir, "../../suse7-frontend/src/components/pricing/PricingScenarioMetricValue.jsx"),
    "utf8",
  );
  assert.match(src, /pricing-scenario-metric-value__loading/);
  assert.match(src, /aria-label="Carregando"/);
}

const TESTS = [
  ["chave financeira muda com promotion_id", testChaveFinanceiraMudaComPromocao],
  ["pendente quando chave diverge ou loading", testPendenteQuandoChaveDivergeOuLoading],
  ["CSS respiro bloco Receita promoções", testCssRespiroReceitaPromocoes],
  ["componente PricingScenarioMetricValue", testMetricValueComponenteExiste],
];

let passed = 0;
for (const [label, fn] of TESTS) {
  await fn();
  passed += 1;
  console.log(`OK — ${label}`);
}

console.log(`\n${passed}/${TESTS.length} testes LOADING-AND-SPACING passaram.`);
