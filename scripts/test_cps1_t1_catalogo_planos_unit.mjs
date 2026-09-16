#!/usr/bin/env node
/**
 * CPS 1 / T1 — fonte única de preço e limite (`public.plans`)
 *
 * Prova que preço e limite dos consumidores mudam quando o catálogo muda,
 * sem editar constante de código, e que `billing_plan_limits` só prevalece
 * com exceção comercial explícita.
 */
import {
  ORIGEM_LIMITE_PLANO,
  converterPrecoMensalParaCentavos,
  ehExcecaoGlobalDeLimiteDoPlano,
  normalizarPlanoParaCatalogo,
  resolverLimiteMensalVendas,
} from "../src/billing/domain/catalogoPlanos.js";

/** @type {string[]} */
const falhas = [];

function verificar(nome, condicao) {
  if (!condicao) falhas.push(nome);
}

// ----------------------------------------------------------------------
// Limite mensal: catálogo manda; linha de limites não duplica manutenção
// ----------------------------------------------------------------------
const semLinhaDeLimites = resolverLimiteMensalVendas({ limiteCatalogo: 400 });
verificar("catálogo define o limite quando não há linha de limites", semLinhaDeLimites.limite === 400);
verificar("origem catálogo sem linha de limites", semLinhaDeLimites.origem === ORIGEM_LIMITE_PLANO.CATALOGO);

const comLinhaDesatualizada = resolverLimiteMensalVendas({
  limiteCatalogo: 2500,
  limiteConfigurado: 60,
  metadataLimite: { warning_threshold_percent: 80 },
});
verificar("linha de limites desatualizada não prevalece", comLinhaDesatualizada.limite === 2500);
verificar("origem permanece catálogo", comLinhaDesatualizada.origem === ORIGEM_LIMITE_PLANO.CATALOGO);

const comExcecaoGlobal = resolverLimiteMensalVendas({
  limiteCatalogo: 100,
  limiteConfigurado: 5000,
  metadataLimite: { excecao_global_do_plano: true },
});
verificar("exceção global do plano prevalece", comExcecaoGlobal.limite === 5000);
verificar("origem exceção global do plano", comExcecaoGlobal.origem === ORIGEM_LIMITE_PLANO.EXCECAO_GLOBAL_DO_PLANO);

verificar("marcador legado de exceção reconhecido", ehExcecaoGlobalDeLimiteDoPlano({ commercial_exception: true }));
verificar("metadata comum não é exceção", !ehExcecaoGlobalDeLimiteDoPlano({ grace_period_days: 3 }));

// Alcance (parecer CPF v2, bloqueio 4): o marcador vale para o plano inteiro.
// Identificação de seller/assinatura na metadata da linha de limites não
// transforma a linha em condição individual.
const comMarcadorIndividual = resolverLimiteMensalVendas({
  limiteCatalogo: 100,
  limiteConfigurado: 5000,
  metadataLimite: { user_id: "00000000-0000-4000-8000-000000000000", subscription_id: "abc", seller_exception: true },
});
verificar("metadata com identificação individual não vira exceção de plano", comMarcadorIndividual.limite === 100);
verificar("origem permanece catálogo com marcador individual", comMarcadorIndividual.origem === ORIGEM_LIMITE_PLANO.CATALOGO);
verificar(
  "marcador individual não é aceito como exceção global",
  !ehExcecaoGlobalDeLimiteDoPlano({ seller_exception: true, subscription_id: "abc" })
);

const semCatalogo = resolverLimiteMensalVendas({ limiteCatalogo: null, limiteConfigurado: null });
verificar("sem catálogo o limite fica indisponível", semCatalogo.limite === null);
verificar("origem indisponível", semCatalogo.origem === ORIGEM_LIMITE_PLANO.INDISPONIVEL);

// Mesma função, catálogo diferente: resultado acompanha o dado, não o código.
const catalogoAprovado = [
  { plan_key: "baby", price_monthly: "0.00", sales_limit_monthly: 30, price_cents: 5900 },
  { plan_key: "start", price_monthly: "33.00", sales_limit_monthly: 100, price_cents: 9900 },
  { plan_key: "crescer", price_monthly: "66.00", sales_limit_monthly: 400 },
  { plan_key: "pro", price_monthly: "159.00", sales_limit_monthly: 1000 },
  { plan_key: "scale", price_monthly: "349.00", sales_limit_monthly: 2500 },
  { plan_key: "elite", price_monthly: "639.00", sales_limit_monthly: 8000 },
  { plan_key: "enterprise", price_monthly: "1333.00", sales_limit_monthly: 20000 },
];

const limitesResolvidos = catalogoAprovado.map(
  (plano) => resolverLimiteMensalVendas({ limiteCatalogo: plano.sales_limit_monthly }).limite
);
verificar(
  "limites acompanham o catálogo aprovado",
  JSON.stringify(limitesResolvidos) === JSON.stringify([30, 100, 400, 1000, 2500, 8000, 20000])
);

// ----------------------------------------------------------------------
// price_cents: compatibilidade derivada, com conversão exata
// ----------------------------------------------------------------------
verificar("0.00 vira 0 centavos", converterPrecoMensalParaCentavos("0.00") === 0);
verificar("33.00 vira 3300 centavos", converterPrecoMensalParaCentavos("33.00") === 3300);
verificar("66.00 vira 6600 centavos", converterPrecoMensalParaCentavos("66.00") === 6600);
verificar("159.00 vira 15900 centavos", converterPrecoMensalParaCentavos("159.00") === 15900);
verificar("349.00 vira 34900 centavos", converterPrecoMensalParaCentavos("349.00") === 34900);
verificar("639.00 vira 63900 centavos", converterPrecoMensalParaCentavos("639.00") === 63900);
verificar("1333.00 vira 133300 centavos", converterPrecoMensalParaCentavos("1333.00") === 133300);
verificar("centavos quebrados exatos", converterPrecoMensalParaCentavos("0.07") === 7);
verificar("numeric do Postgres em string longa", converterPrecoMensalParaCentavos("1333.000000") === 133300);
verificar("preço ausente não inventa centavos", converterPrecoMensalParaCentavos(null) === null);
verificar("preço inválido não inventa centavos", converterPrecoMensalParaCentavos("sob consulta") === null);

const planoNormalizado = normalizarPlanoParaCatalogo(catalogoAprovado[1]);
verificar("price_cents divergente é sobrescrito pelo derivado", planoNormalizado.price_cents === 3300);
verificar("price_monthly preservado na normalização", planoNormalizado.price_monthly === "33.00");

const babyNormalizado = normalizarPlanoParaCatalogo(catalogoAprovado[0]);
verificar("Baby gratuito derivado como 0 centavos", babyNormalizado.price_cents === 0);

const infinityNormalizado = normalizarPlanoParaCatalogo({
  plan_key: "infinity",
  price_monthly: null,
  pricing_mode: "quote",
});
verificar("Infinity sem preço permanece sem centavos", infinityNormalizado.price_cents === null);
verificar("Infinity preserva pricing_mode", infinityNormalizado.pricing_mode === "quote");

if (falhas.length) {
  console.error("[CPS1.T1 catálogo de planos] FAIL");
  for (const falha of falhas) console.error(" -", falha);
  process.exit(1);
}

console.log("[OK] test_cps1_t1_catalogo_planos_unit.mjs");
