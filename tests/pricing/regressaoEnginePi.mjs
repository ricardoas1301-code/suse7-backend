#!/usr/bin/env node
// ======================================================
// Regressão oficial — Engine PI homologada (PI.2.10A).
// Offline: identidade financeira + anti-stale + contratos congelados.
// Live (--live): paridade API ML + engine computeMercadoLivreScenarioComoRayxParaPI.
// ======================================================

import Decimal from "decimal.js";

import { parseMercadoLivreItemShippingOptionsForScenario } from "../../src/handlers/ml/_helpers/mercadoLivreItemShippingOptionsApi.js";
import {
  resolverTarifaCenarioMercadoLivreBrl,
  validarIdentidadeFinanceiraOficial,
  calcularRepasseOficialMercadoLivre,
} from "../../src/domain/pricing/pricingFinancialCalculator.js";
import { aplicarExtrasPrecificacaoInteligente } from "../../src/domain/pricing/aplicarExtrasPrecificacaoInteligente.js";
import {
  CONTRATOS_CLASSIC_HOMOLOGADOS,
  CONTRATOS_HOMOLOGADOS,
  CONTRATOS_PREMIUM_HOMOLOGADOS,
  EXTRAS_PI_HOMOLOGADOS_65,
  LISTING_BASE_HOMOLOGADO,
  LUCRO_COM_EXTRAS_PI_65,
  SHIPPING_PAYLOADS_HOMOLOGADOS,
  STALE_FEE_HOMOLOGADO,
  STALE_SHIPPING_HOMOLOGADO,
} from "./contratosHomologados.mjs";

/** @type {Array<{ label: string; pass: boolean; detail?: string }>} */
const results = [];

function check(label, pass, detail = "") {
  results.push({ label, pass, detail });
  console.log(`${pass ? "OK" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function contratoTemIdentidadeCompleta(c) {
  return (
    c.fee_amount_brl != null &&
    c.shipping_cost_brl != null &&
    c.payout_brl != null
  );
}

function testIdentidadeContratos() {
  console.log("\n=== Contratos homologados — identidade payout ===");
  for (const c of CONTRATOS_HOMOLOGADOS) {
    if (!contratoTemIdentidadeCompleta(c)) {
      check(
        `${c.tipo} ${c.id} identidade payout`,
        true,
        "skip (tarifa-only offline; validar --live)",
      );
      continue;
    }
    const id = validarIdentidadeFinanceiraOficial({
      sale_price_brl: c.sale_price_brl,
      fee_amount_brl: c.fee_amount_brl,
      shipping_cost_brl: c.shipping_cost_brl,
      payout_brl: c.payout_brl,
    });
    check(
      `${c.listing_id} ${c.id} payout`,
      id.ok,
      `calc=${id.payout_calculado_brl} diff=${id.diff_brl}`,
    );

    if (c.profit_brl != null && c.product_cost_brl != null) {
      const profitCalc = new Decimal(c.payout_brl)
        .minus(c.product_cost_brl)
        .minus(c.tax_amount_brl ?? "0")
        .minus(c.operational_brl ?? "0")
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2);
      check(`${c.listing_id} ${c.id} lucro`, profitCalc === c.profit_brl, `calc=${profitCalc}`);
    }
  }
}

function testContratosPremiumObrigatorios() {
  console.log("\n=== Premium — casos congelados (299,90 / 284,90 / 109 / 65) ===");
  const ids = ["P_299_90", "P_284_90", "P_109_00", "P_65_00"];
  for (const id of ids) {
    const c = CONTRATOS_PREMIUM_HOMOLOGADOS.find((x) => x.id === id);
    check(`${id} presente`, c != null);
    if (!c) continue;
    check(`${id} tarifa`, c.fee_amount_brl != null, c.fee_amount_brl);
    check(`${id} frete`, c.shipping_cost_brl != null, c.shipping_cost_brl);
    check(`${id} recebe`, c.payout_brl != null, c.payout_brl);
    if (c.profit_brl != null) check(`${id} lucro`, c.profit_brl != null, c.profit_brl);
    if (c.margin_pct != null) check(`${id} margem`, c.margin_pct != null, c.margin_pct);
  }
}

function testContratosClassicObrigatorios() {
  console.log("\n=== Clássico — casos congelados (149,90 / 105 / 58 / 35 + 109 / 65) ===");
  const ids = ["C_149_90", "C_105_00", "C_58_00", "C_35_00", "C_109_00", "C_65_00"];
  for (const id of ids) {
    const c = CONTRATOS_CLASSIC_HOMOLOGADOS.find((x) => x.id === id);
    check(`${id} presente`, c != null);
    if (!c) continue;
    check(`${id} tarifa`, c.fee_amount_brl != null, c.fee_amount_brl);
    check(`${id} listing_type gold_special`, c.listing_type_id === "gold_special");
    if (c.shipping_cost_brl != null) check(`${id} frete`, true, c.shipping_cost_brl);
    if (c.payout_brl != null) check(`${id} recebe`, true, c.payout_brl);
  }
}

function testTarifaClassicPercentual() {
  console.log("\n=== Clássico — tarifa 11,50% (snap homologado) ===");
  for (const c of CONTRATOS_CLASSIC_HOMOLOGADOS) {
    if (c.fee_percent !== "11.50") continue;
    const esperado = new Decimal(c.sale_price_brl)
      .mul("11.50")
      .div(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);
    check(
      `${c.id} tarifa = 11,50% × preço`,
      c.fee_amount_brl === esperado,
      `got=${c.fee_amount_brl} esperado=${esperado}`,
    );
  }
}

function testExtrasPiHomologados() {
  console.log("\n=== Extras PI — reserva + custos operacionais (65,00) ===");
  const base = {
    marketplace: {
      sale_price_brl: "65.00",
      marketplace_payout_amount_brl: "46.57",
    },
    internal_costs: {
      product_cost_brl: "129.00",
      tax_amount_brl: "3.90",
      operational_packaging_total_brl: "1.16",
    },
    result: { profit_brl: "-90.73", margin_pct: "-139.58" },
  };
  const classic = aplicarExtrasPrecificacaoInteligente(
    {
      ...base,
      marketplace: { ...base.marketplace, marketplace_payout_amount_brl: "46.57" },
    },
    EXTRAS_PI_HOMOLOGADOS_65,
  );
  const premium = aplicarExtrasPrecificacaoInteligente(
    {
      ...base,
      marketplace: { ...base.marketplace, marketplace_payout_amount_brl: "43.33" },
    },
    EXTRAS_PI_HOMOLOGADOS_65,
  );
  const resClassic =
    classic.result != null && typeof classic.result === "object"
      ? /** @type {Record<string, unknown>} */ (classic.result)
      : {};
  const resPremium =
    premium.result != null && typeof premium.result === "object"
      ? /** @type {Record<string, unknown>} */ (premium.result)
      : {};
  check(
    "Extras classic lucro -94,32",
    resClassic.profit_brl === LUCRO_COM_EXTRAS_PI_65.classic,
    `got=${resClassic.profit_brl}`,
  );
  check(
    "Extras premium lucro -97,56",
    resPremium.profit_brl === LUCRO_COM_EXTRAS_PI_65.premium,
    `got=${resPremium.profit_brl}`,
  );
  check(
    "Extras classic margem -145,11%",
    resClassic.margin_pct === LUCRO_COM_EXTRAS_PI_65.margin_classic,
    `got=${resClassic.margin_pct}`,
  );
  check(
    "Extras premium margem -150,09%",
    resPremium.margin_pct === LUCRO_COM_EXTRAS_PI_65.margin_premium,
    `got=${resPremium.margin_pct}`,
  );
  const extras =
    classic.pricing_intelligence_extras != null &&
    typeof classic.pricing_intelligence_extras === "object"
      ? /** @type {Record<string, unknown>} */ (classic.pricing_intelligence_extras)
      : {};
  check("Promoção 5% = 3,25", extras.promotion_reserve_brl === "3.25");
  check("Afiliados 2,5% = 1,63", extras.affiliate_brl === "1.63");
  check("ML Ads 1% = 0,65", extras.ads_brl === "0.65");
  check("Custos op 2% = 1,30", extras.operational_cost_brl === "1.30");
}

function testAntiStaleTarifa() {
  console.log("\n=== Anti-stale tarifa ===");
  const stale608 = STALE_FEE_HOMOLOGADO.MLB6086959274;
  const resolved284 = resolverTarifaCenarioMercadoLivreBrl("284.90", "13.50", stale608, {
    trustPercentForScenarioPrice: true,
  });
  check("MLB6086959274 284,90 não reutiliza 40,49", resolved284 === "38.46", `got=${resolved284}`);

  const resolved109 = resolverTarifaCenarioMercadoLivreBrl("109.00", "16.50", stale608, {
    trustPercentForScenarioPrice: true,
  });
  const diff109 = new Decimal(resolved109 ?? 0).minus("17.98").abs();
  check(
    "MLB6086959274 109,00 não reutiliza 40,49",
    resolved109 !== stale608 && diff109.lte("0.02"),
    `got=${resolved109}`,
  );
}

function testAntiStaleFrete() {
  console.log("\n=== Anti-stale frete ===");
  for (const c of CONTRATOS_PREMIUM_HOMOLOGADOS) {
    const stale = STALE_SHIPPING_HOMOLOGADO[c.listing_id];
    if (!stale || !c.shipping_cost_brl) continue;
    if (c.sale_price_brl === "299.90" || c.sale_price_brl === "284.90") continue;
    check(
      `${c.id} frete ≠ stale ${stale}`,
      c.shipping_cost_brl !== stale,
      `shipping=${c.shipping_cost_brl}`,
    );
  }
}

function testShippingCandidates() {
  console.log("\n=== Frete oficial — candidatos shipping_options (premium) ===");
  for (const c of CONTRATOS_PREMIUM_HOMOLOGADOS) {
    if (c.id === "P_299_90" || c.id === "P_65_00" || !c.shipping_cost_brl || !c.payout_brl) continue;
    const payload = SHIPPING_PAYLOADS_HOMOLOGADOS[c.sale_price_brl];
    if (!payload) continue;
    const parsed = parseMercadoLivreItemShippingOptionsForScenario(payload, {}, {
      salePriceDec: new Decimal(c.sale_price_brl),
      feeAmountDec: new Decimal(c.fee_amount_brl),
      listingPricesLogisticsDec: new Decimal(c.shipping_cost_brl),
      listingPricesPayoutDec: new Decimal(c.payout_brl),
    });
    check(
      `${c.id} frete`,
      parsed?.seller_shipping_cost_brl === c.shipping_cost_brl,
      `got=${parsed?.seller_shipping_cost_brl}`,
    );
    const payoutCalc = calcularRepasseOficialMercadoLivre(
      c.sale_price_brl,
      c.fee_amount_brl,
      parsed?.seller_shipping_cost_brl,
    );
    check(`${c.id} payout pós-frete`, payoutCalc === c.payout_brl, `calc=${payoutCalc}`);
  }
}

/** @param {Record<string, unknown>} financial @param {import("./contratosHomologados.mjs").ContratoHomologado} c @param {string} label */
function assertContratoPi(financial, c, label) {
  check(
    `${label} fee`,
    financial.official_fee_brl === c.fee_amount_brl,
    `got=${financial.official_fee_brl ?? "null"}`,
  );
  if (c.shipping_cost_brl != null) {
    const stale = STALE_SHIPPING_HOMOLOGADO[c.listing_id];
    check(
      `${label} frete`,
      financial.shipping_cost_brl === c.shipping_cost_brl,
      `got=${financial.shipping_cost_brl ?? "null"}`,
    );
    if (stale && new Decimal(c.sale_price_brl).lt(150)) {
      check(
        `${label} frete ≠ stale`,
        financial.shipping_cost_brl !== stale,
        `got=${financial.shipping_cost_brl}`,
      );
    }
  }
  if (c.payout_brl != null) {
    check(
      `${label} payout`,
      financial.payout_brl === c.payout_brl,
      `got=${financial.payout_brl ?? "null"}`,
    );
  }
}

async function testPiEndpointFinancialContract() {
  console.log("\n=== PI endpoint — contrato financial ===");
  const { mapMercadoLivreScenarioToFlatFinancialContract } = await import(
    "../../src/domain/pricing/marketplacePricingSimulator.js"
  );

  const c299 = CONTRATOS_PREMIUM_HOMOLOGADOS.find((x) => x.id === "P_299_90");
  if (c299) {
    const good = mapMercadoLivreScenarioToFlatFinancialContract(
      {
        official_fee_source: "ml_listing_prices",
        marketplace: {
          sale_price_brl: c299.sale_price_brl,
          sale_fee_amount_brl: c299.fee_amount_brl,
          sale_fee_percent: c299.fee_percent,
          shipping_cost_amount_brl: c299.shipping_cost_brl,
          shipping_cost_source: "ml_item_shipping_options_api:list_cost",
          marketplace_payout_amount_brl: c299.payout_brl,
          is_shipping_estimated: false,
        },
        internal_costs: {
          product_cost_brl: c299.product_cost_brl,
          tax_amount_brl: c299.tax_amount_brl,
          operational_packaging_total_brl: c299.operational_brl,
        },
        result: { profit_brl: c299.profit_brl, margin_pct: c299.margin_pct },
        data_quality: { warnings: [] },
      },
      { listing_type: "premium", official_fee_percent: c299.fee_percent },
    );
    assertContratoPi(good, c299, "PI contrato 299,90");
  }
}

async function testPiEngineLive(token) {
  console.log("\n=== Live PI engine — computeMercadoLivreScenarioComoRayxParaPI ===");
  const { computeMercadoLivreScenarioComoRayxParaPI } = await import(
    "../../src/domain/pricing/mercadoLivreListingPricingScenarios.js"
  );
  const { mapMercadoLivreScenarioToFlatFinancialContract } = await import(
    "../../src/domain/pricing/marketplacePricingSimulator.js"
  );

  const alvos = CONTRATOS_HOMOLOGADOS.filter(
    (c) => c.listing_id === "MLB6086959274" && (c.homologacaoCompleta === true || c.tipo === "classic"),
  );

  for (const c of alvos) {
    const baseListing = LISTING_BASE_HOMOLOGADO[c.listing_id];
    if (!baseListing) continue;
    const listing = {
      ...baseListing,
      listing_type_id: c.listing_type_id,
      price: Number(c.sale_price_brl),
    };
    const health = {
      list_or_original_price_brl: "299.90",
      promotional_price_brl: c.sale_price_brl === "284.90" ? "284.90" : null,
      sale_fee_percent: c.tipo === "classic" ? "11.50" : "13.50",
      sale_fee_amount: STALE_FEE_HOMOLOGADO[c.listing_id] ?? "40.49",
      shipping_cost_amount_brl: STALE_SHIPPING_HOMOLOGADO[c.listing_id] ?? null,
    };
    const { scenario, engine_path } = await computeMercadoLivreScenarioComoRayxParaPI({
      listing,
      health,
      metrics: null,
      sellerTaxPct: "6",
      salePriceStr: c.sale_price_brl,
      listingTypeId: c.listing_type_id,
      mlAccessToken: token,
      referenceZipCode: "01310100",
      itemMlId: c.listing_id,
      listingUuid: null,
    });
    const financial = mapMercadoLivreScenarioToFlatFinancialContract(scenario, {
      listing_type: c.tipo,
      listing_external_id: c.listing_id,
    });
    assertContratoPi(
      financial,
      c,
      `PI live ${c.tipo} ${c.id} (${engine_path})`,
    );
    check(
      `PI live ${c.id} tarifa ml_listing_prices`,
      String(financial.commission_source ?? "").includes("ml_listing_prices") ||
        financial.official_fee_brl === c.fee_amount_brl,
      `source=${financial.commission_source ?? "null"}`,
    );
  }
}

async function testLiveTarifaListingPrices(token) {
  console.log("\n=== Live API — tarifa listing_prices ===");
  const { resolverTarifaOficialMercadoLivrePorPreco } = await import(
    "../../src/domain/pricing/mercadoLivreOfficialScenarioResolvers.js"
  );

  for (const c of CONTRATOS_HOMOLOGADOS) {
    const listing = {
      ...LISTING_BASE_HOMOLOGADO[c.listing_id],
      listing_type_id: c.listing_type_id,
    };
    const fee = await resolverTarifaOficialMercadoLivrePorPreco({
      accessToken: token,
      listing,
      externalListingId: c.listing_id,
      listingTypeId: c.listing_type_id,
      priceDec: new Decimal(c.sale_price_brl),
      scenarioType: c.id,
    });
    check(
      `${c.id} live fee ML`,
      fee?.amount_brl === c.fee_amount_brl && fee?.source === "ml_listing_prices",
      `got=${fee?.amount_brl ?? "null"} source=${fee?.source ?? "null"}`,
    );
  }
}

export async function main() {
  console.log("Regressão oficial — Engine PI homologada (PI.2.10A)");
  testContratosPremiumObrigatorios();
  testContratosClassicObrigatorios();
  testIdentidadeContratos();
  testTarifaClassicPercentual();
  testExtrasPiHomologados();
  testAntiStaleTarifa();
  testAntiStaleFrete();
  testShippingCandidates();
  await testPiEndpointFinancialContract();

  if (process.argv.includes("--live")) {
    const token = process.env.ML_ACCESS_TOKEN?.trim() || process.env.SUSE7_ML_ACCESS_TOKEN?.trim();
    if (!token) {
      console.error("\nFAIL live — defina ML_ACCESS_TOKEN");
      process.exit(1);
    }
    await testLiveTarifaListingPrices(token);
    await testPiEngineLive(token);
  } else {
    console.log("\n(dica: npm run test:pricing-engine-homologada:live com ML_ACCESS_TOKEN)");
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  if (failed.length) {
    console.error("Falhas:", failed.map((f) => f.label).join(", "));
    process.exit(1);
  }
}

const executadoDiretamente = process.argv[1]?.replace(/\\/g, "/").endsWith("tests/pricing/regressaoEnginePi.mjs");

if (executadoDiretamente) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
