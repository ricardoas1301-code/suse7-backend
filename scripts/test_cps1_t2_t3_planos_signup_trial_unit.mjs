#!/usr/bin/env node
/**
 * CPS 1 / T2 e T3 — testes unitários do delta
 * Estrutural + simulação de domínio. Sem PostgreSQL e sem cobrança real.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projetarCamposPublicosDoPlano } from "../src/billing/domain/catalogoPlanos.js";
import { resolverIntencaoComercialNoCatalogo } from "../src/billing/domain/intencaoComercialPlano.js";
import {
  calcularProjecaoPedidosTrial,
  montarRecomendacaoPlanoTrial,
  selecionarPlanoRecomendadoPelaProjecao,
} from "../src/billing/domain/recomendacaoPlanoTrial.js";
import { inheritBillingCycleFromSupersededSubscriptions } from "../src/billing/services/billingCycleService.js";
import { evaluateSalesLimitState } from "../src/billing/services/billingUsageService.js";

const root = dirname(fileURLToPath(import.meta.url));
const ler = (relativo) => readFileSync(join(root, relativo), "utf8");

/** @type {string[]} */
const falhas = [];
function verificar(nome, condicao) {
  if (!condicao) falhas.push(nome);
}

const rotas = ler("../src/billing/routes/billingRoutes.js");
const rotasSignup = ler("../src/signup/routes/signupRoutes.js");
const confirmacao = ler("../src/billing/services/billingConfirmCanonicalSubscriptionPaymentService.js");
const ciclo = ler("../src/billing/services/billingCycleService.js");
const uso = ler("../src/billing/services/billingUsageService.js");

verificar("GET /api/billing/plans não exige requireAuthUser", !/if \(pathNorm === "\/api\/billing\/plans"\)[\s\S]{0,400}requireAuthUser/.test(rotas));
verificar("catálogo público recorta campos", rotas.includes("projetarCamposPublicosDoPlano"));
verificar("checkout continua autenticado", rotas.includes('pathNorm === "/api/billing/checkout/card"') && rotas.includes("requireAuthUser(req)"));
verificar("intenção comercial autenticada", rotas.includes("/api/billing/commercial-intent"));
verificar("signup aceita intended_plan_key sem quebrar cadastro", rotasSignup.includes("intended_plan_key"));
verificar("confirmação paga converte trial", confirmacao.includes("transitionConvertTrialToPaid"));
verificar("ciclo pago não herda assinatura interna", ciclo.includes('String(row.provider || "").toLowerCase() === "internal"'));
verificar("uso isenta cota no trial", uso.includes("trialTemporal.active"));

const publico = projetarCamposPublicosDoPlano({
  id: "p1",
  plan_key: "start",
  price_monthly: "33.00",
  sales_limit_monthly: 100,
  metadata: { secret: true },
  provider_price_id: "hidden",
});
verificar("projeção pública expõe preço e limite", publico.plan_key === "start" && publico.sales_limit_monthly === 100);
verificar("projeção pública omite metadata interna", publico.metadata === undefined && publico.provider_price_id === undefined);

const catalogo = [
  { plan_key: "baby", sales_limit_monthly: 30, sort_order: 1 },
  { plan_key: "start", slug: "start", sales_limit_monthly: 100, sort_order: 2 },
  { plan_key: "crescer", sales_limit_monthly: 400, sort_order: 3 },
  { plan_key: "pro", sales_limit_monthly: 1000, sort_order: 4 },
  { plan_key: "scale", sales_limit_monthly: 2500, sort_order: 5 },
  { plan_key: "elite", sales_limit_monthly: 8000, sort_order: 6 },
  { plan_key: "enterprise", sales_limit_monthly: 20000, sort_order: 7 },
  { plan_key: "infinity", sales_limit_monthly: null, pricing_mode: "quote", sort_order: 8 },
];

verificar("chave ausente não inventa plano", resolverIntencaoComercialNoCatalogo(null, catalogo).reason === "absent");
verificar("chave inválida recusada", resolverIntencaoComercialNoCatalogo("drop table", catalogo).ok === false);
verificar("slug válido resolve plan_key", resolverIntencaoComercialNoCatalogo("start", catalogo).plan_key === "start");
verificar("chave fora do catálogo recusada", resolverIntencaoComercialNoCatalogo("gold", catalogo).reason === "not_in_catalog");

const proj15 = calcularProjecaoPedidosTrial({ pedidosTrial: 15 });
verificar("projeção de 15 pedidos = 30 mensais", proj15.monthly_projection === 30);
verificar("projeção identificada como estimativa", proj15.is_estimate === true);

const fronteiraBaby = montarRecomendacaoPlanoTrial({
  pedidosTrial: 15,
  planos: catalogo,
  periodComplete: true,
  collectionComplete: true,
  chosenPlanKey: "pro",
});
verificar("fronteira 30 recomenda Baby", fronteiraBaby.recommended_plan_key === "baby");
verificar("plano escolhido preservado separado da recomendação", fronteiraBaby.chosen_plan_key === "pro");

const acimaBaby = montarRecomendacaoPlanoTrial({
  pedidosTrial: 16,
  planos: catalogo,
  periodComplete: true,
  collectionComplete: true,
});
verificar("31+ recomenda Start", acimaBaby.recommended_plan_key === "start");

const incompleto = montarRecomendacaoPlanoTrial({
  pedidosTrial: 16,
  planos: catalogo,
  periodComplete: false,
  collectionComplete: true,
});
verificar("período incompleto não é definitivo", incompleto.projection.is_definitive === false);

const sobConsulta = selecionarPlanoRecomendadoPelaProjecao({ projecaoMensal: 20001, planos: catalogo });
verificar("acima dos limites numéricos vai para sob consulta", sobConsulta.recommended_is_quote === true);

const avaliacaoTrial = evaluateSalesLimitState({
  monthly_sales_limit: null,
  current_month_sales: 80,
  warning_threshold_percent: 80,
  grace_period_days: 0,
  hard_block_enabled: true,
});
verificar("sem limite não bloqueia mesmo acima do Baby", avaliacaoTrial.hard_blocked === false && avaliacaoTrial.ux_state === "unmetered");

const agora = new Date("2026-09-16T14:00:00.000Z");
const herdado = inheritBillingCycleFromSupersededSubscriptions(
  [
    {
      id: "baby-1",
      provider: "internal",
      status: "internal_free",
      created_at: "2026-08-14T00:00:00.000Z",
      current_period_start: "2026-08-14T00:00:00.000Z",
      current_period_end: "2026-09-13T23:59:59.999Z",
      next_due_date: "2026-09-14",
    },
    {
      id: "paid-keep",
      provider: "asaas",
      status: "pending",
      created_at: "2026-09-16T14:00:00.000Z",
    },
  ],
  "paid-keep",
  agora
);
verificar("primeiro ciclo pago não herda período Baby", herdado == null);

if (falhas.length) {
  console.error("[CPS1.T2-T3 unit] FAIL");
  for (const falha of falhas) console.error(" -", falha);
  process.exit(1);
}

console.log("[OK] test_cps1_t2_t3_planos_signup_trial_unit.mjs (estrutural + simulação; PostgreSQL não executado)");
