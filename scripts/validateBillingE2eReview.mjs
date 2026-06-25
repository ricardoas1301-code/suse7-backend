#!/usr/bin/env node
/**
 * BILLING 04.15 — revisão final E2E (orquestra scripts de validação).
 * Uso: node scripts/validateBillingE2eReview.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

/** @type {Array<{ id: string; script: string; scope: string }>} */
const SUITES = [
  { id: "04.9", script: "validateBillingCheckoutWebhookE2e.mjs", scope: "checkout + webhook + histórico" },
  { id: "04.11", script: "validateBillingPeriodExpiration.mjs", scope: "cancelamento → Baby + job" },
  { id: "04.12", script: "validateBillingDunning.mjs", scope: "inadimplência + grace + recuperação" },
  { id: "04.13", script: "validateBillingPlanChange.mjs", scope: "reativação + troca de plano" },
  { id: "04.14", script: "validateBillingScheduledDowngradeExpiration.mjs", scope: "downgrade agendado no fim do ciclo" },
];

/**
 * @param {string} script
 */
function runSuite(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(rootDir, "scripts", script)], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  console.log("=== S7 BILLING 04.15 — revisão final E2E ===\n");

  /** @type {Array<{ id: string; script: string; scope: string; ok: boolean }>} */
  const results = [];

  for (const suite of SUITES) {
    console.log(`\n>>> ${suite.id} — ${suite.scope}`);
    const code = await runSuite(suite.script);
    results.push({ ...suite, ok: code === 0 });
    if (code !== 0) {
      console.error(`\nSuite ${suite.script} falhou com código ${code}.`);
    }
  }

  const passed = results.filter((item) => item.ok);
  const failed = results.filter((item) => !item.ok);

  console.log("\n=== Resumo automatizado ===");
  for (const item of results) {
    console.log(`${item.ok ? "PASS" : "FAIL"} — ${item.id} (${item.script})`);
  }

  console.log("\n=== Checklist manual pós-deploy (DEV) ===");
  console.log("- Baby inicial visível em Minha assinatura e Planos");
  console.log("- Checkout Asaas real (PIX/boleto) e webhook em ambiente com ASAAS_*");
  console.log("- GET /api/billing/subscription/status como fonte única do frontend");
  console.log("- Estados vazios: sem plano, sem formas de pagamento, sem histórico");
  console.log("- Avisos: cancel_at_period_end, plan_change_at_period_end, inadimplência");
  console.log("- Cron/job: process-period-expirations e process-overdues em produção");

  console.log("\n=== Pendências conhecidas (fora dos scripts) ===");
  console.log("- Consumo mensal: validar com dados reais de vendas (scripts logam usage fallback em DEV)");
  console.log("- Baby na criação de conta: coberto no backend, sem script dedicado nesta suíte");
  console.log("- Cartão de crédito e tokenização de payment methods: UI placeholder");
  console.log("- Downgrade pago sem cobrança imediata: MVP local; reconciliar com Asaas depois");
  console.log("- Frontend: CTAs de upgrade/downgrade usam sort_order do catálogo só para UX; regras no backend");

  console.log(`\nTotal: ${passed.length}/${results.length} suítes automatizadas aprovadas`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
