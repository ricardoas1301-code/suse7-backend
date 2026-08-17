// ======================================================================
// Testes unitários — S1.PROMO-CARDS-UX-FINAL-POLISH
// ======================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPACT_PICKER_PATH = join(
  __dirname,
  "../../suse7-frontend/src/components/pricing/PricingIntelligencePromotionsCompactPicker.jsx",
);

async function testCabecalhoCentralPrecoEncurtado() {
  const { resolverPrecoOriginalPromocaoExibicao } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionCardContract.js"
  );

  const exibicao = resolverPrecoOriginalPromocaoExibicao({
    promotion_card_contract: { original_price_brl: "269.90" },
  });

  assert.ok(exibicao != null);
  assert.match(exibicao.replace(/\u00a0/g, " "), /^Preço R\$ 269,90$/);
  assert.doesNotMatch(exibicao, /Preço original/i);
  assert.doesNotMatch(exibicao, /:/);
}

async function testMiniCardsSemTitleDuplicado() {
  const src = readFileSync(COMPACT_PICKER_PATH, "utf8");

  const duplicados = [
    "title={meta.nome}",
    "title={meta.periodo}",
    "title={meta.precoPromocional}",
    "title={meta.descontoResumo}",
    "title={meta.descontoReaisResumo}",
  ];

  for (const token of duplicados) {
    assert.equal(
      src.includes(token),
      false,
      `title duplicado ainda presente no mini card: ${token}`,
    );
  }

  assert.equal(src.includes('title="Oferta relâmpago"'), true, "tooltip funcional do ícone relâmpago preservado");
}

async function testLightningContinuaTraduzida() {
  const { resolverNomePromocaoExibicao } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js"
  );

  assert.equal(
    resolverNomePromocaoExibicao({
      promotion_name: "LIGHTNING",
      promotion_type: "LIGHTNING",
    }),
    "Oferta relâmpago",
  );
}

const TESTS = [
  ["cabecalho central Preço R$ X", testCabecalhoCentralPrecoEncurtado],
  ["mini cards sem title duplicado", testMiniCardsSemTitleDuplicado],
  ["Oferta relampago traduzida", testLightningContinuaTraduzida],
];

let passed = 0;
for (const [label, fn] of TESTS) {
  await fn();
  passed += 1;
  console.log(`OK — ${label}`);
}

console.log(`\n${passed}/${TESTS.length} testes UX FINAL-POLISH passaram.`);
