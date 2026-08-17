#!/usr/bin/env node
/**
 * BILLING 04.17 — relatório GO/NO-GO para smoke DEV Asaas + cron protegido.
 * Uso: node scripts/validateBillingProductionGoNoGo.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env.vercel" });
loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

/** @type {Array<{ area: string; status: "approved" | "pending" | "failed"; detail: string }>} */
const report = [];

function setArea(area, status, detail) {
  report.push({ area, status, detail });
}

/**
 * @param {string} script
 */
function runScript(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(rootDir, "scripts", script)], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function evaluateAsaasEnv() {
  const baseUrl = process.env.ASAAS_API_BASE_URL?.trim() || "";
  const apiKey = process.env.ASAAS_API_KEY?.trim() || "";
  const webhookToken = process.env.ASAAS_WEBHOOK_TOKEN?.trim() || "";
  const env = process.env.ASAAS_ENV?.trim() || "sandbox";

  if (!baseUrl || !apiKey || !webhookToken) {
    setArea(
      "Asaas real",
      "pending",
      "Defina ASAAS_API_BASE_URL, ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN no ambiente alvo."
    );
    setArea(
      "Webhook real",
      "pending",
      "Configure webhook Asaas apontando para /api/billing/webhooks/asaas com o mesmo ASAAS_WEBHOOK_TOKEN."
    );
    return;
  }

  setArea(
    "Asaas real",
    "pending",
    `Variáveis presentes (env=${env}). Falta smoke manual: checkout PIX/Boleto real + invoice_url/PIX no host DEV.`
  );
  setArea(
    "Webhook real",
    "pending",
    "Token configurado. Falta confirmar entrega real do Asaas e PAYMENT_CONFIRMED no host DEV."
  );
}

async function main() {
  console.log("=== S7 BILLING 04.17 — GO/NO-GO smoke DEV Asaas + cron ===\n");

  if (!process.env.S7_BILLING_DEV_BASE_URL?.trim()) {
    process.env.S7_BILLING_DEV_BASE_URL = "https://suse7-backend-dev.vercel.app";
  }

  evaluateAsaasEnv();

  const e2eCode = await runScript("validateBillingE2eReview.mjs");
  setArea(
    "Suíte automatizada 04.9–04.14",
    e2eCode === 0 ? "approved" : "failed",
    e2eCode === 0 ? "validateBillingE2eReview.mjs OK" : `exit=${e2eCode}`
  );

  const usageCode = await runScript("validateBillingMonthlyUsageRealSales.mjs");
  setArea(
    "Consumo real",
    usageCode === 0 ? "approved" : "failed",
    usageCode === 0 ? "sales_order_items + total_sales_month no ciclo" : `exit=${usageCode}`
  );

  const jobsCode = await runScript("validateBillingJobRoutesAuth.mjs");
  const hasJobSecret = Boolean(process.env.JOB_SECRET?.trim() || process.env.DEV_JOB_SECRET?.trim());
  setArea(
    "Jobs/cron",
    jobsCode === 0 ? "approved" : "pending",
    jobsCode === 0
      ? "Rotas /api/jobs/billing-* e dev protegidas com X-Job-Secret; workflows GitHub diários adicionados."
      : "Implementação pronta no código; validar HTTP após deploy/restart do backend (validateBillingJobRoutesAuth)."
  );

  const failed = report.filter((item) => item.status === "failed");
  const pending = report.filter((item) => item.status === "pending");
  const approved = report.filter((item) => item.status === "approved");

  console.log("\n=== Relatório ===");
  for (const item of report) {
    const label = item.status === "approved" ? "APROVADO" : item.status === "pending" ? "PENDENTE" : "FALHOU";
    console.log(`${label} — ${item.area}: ${item.detail}`);
  }

  console.log("\n=== Riscos restantes ===");
  console.log("- Downgrade pago no fim do ciclo sem nova cobrança Asaas (MVP local).");
  console.log("- Cartão/tokenização de formas de pagamento ainda placeholder.");
  console.log("- Consumo depende de sales_order_items populados pelos syncs de marketplace.");
  console.log("- Cron GitHub exige secrets de URL + JOB_SECRET no repositório/ambiente.");

  const recommendation =
    failed.length > 0
      ? "NO-GO"
      : pending.length > 0
        ? "GO condicional"
        : "GO controlado";
  console.log(`\nRecomendação final: ${recommendation}`);
  console.log(
    `Resumo: ${approved.length} aprovado(s), ${pending.length} pendente(s), ${failed.length} falha(s).`
  );

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
