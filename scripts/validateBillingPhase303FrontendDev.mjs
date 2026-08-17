#!/usr/bin/env node
/**
 * Fase 3.0.3 — validação frontend DEV deploy + APIs (dados reais).
 * Uso: node scripts/validateBillingPhase303FrontendDev.mjs
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: "../suse7-frontend/.env.development" });
loadEnv({ path: ".env.local" });
loadEnv();

const frontendUrl = (process.env.S7_FRONTEND_DEV_URL || "https://suse7.com.br").replace(/\/+$/, "");
const backendUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim();
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";

/** @type {string[]} */
const results = [];

function pass(msg) {
  results.push(`PASS: ${msg}`);
  console.log(`PASS: ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `FAIL: ${msg} — ${detail}` : `FAIL: ${msg}`;
  results.push(line);
  console.error(line);
}

async function resolveJwt() {
  const key = anonKey;
  if (!supabaseUrl || !key) return null;
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const json = await res.json();
  return typeof json?.access_token === "string" ? json.access_token : null;
}

async function fetchDeployedBundleMarkers() {
  const indexRes = await fetch(`${frontendUrl}/`);
  const indexHtml = await indexRes.text();
  const jsMatch = indexHtml.match(/\/assets\/index-[^"]+\.js/);
  const cssMatch = indexHtml.match(/\/assets\/index-[^"]+\.css/);
  if (!jsMatch?.[0]) return { ok: false, reason: "bundle js não encontrado no index" };

  const jsUrl = `${frontendUrl}${jsMatch[0]}`;
  const cssUrl = cssMatch?.[0] ? `${frontendUrl}${cssMatch[0]}` : null;
  const jsRes = await fetch(jsUrl);
  const js = await jsRes.text();
  const css = cssUrl ? await fetch(cssUrl).then((r) => r.text()) : "";

  const markers = [
    "Histórico financeiro",
    "Timeline financeira",
    "Ver detalhes",
    "Saúde financeira",
    "Notificações recentes",
    "Cobranças e pagamentos",
    "Pagamentos",
    "Renovações",
    "Ocultar detalhes",
  ];

  const missing = markers.filter((m) => !js.includes(m) && !css.includes(m));
  return { ok: missing.length === 0, missing, jsUrl };
}

async function main() {
  console.log(`=== Fase 3.0.3 — Frontend (${frontendUrl}) + Backend (${backendUrl}) ===`);

  const bundle = await fetchDeployedBundleMarkers();
  if (bundle.ok) pass("deploy bundle contém marcadores Fase 3.0.3");
  else fail("deploy bundle Fase 3.0.3", `missing=${bundle.missing?.join(", ")}`);

  const historicoRes = await fetch(`${frontendUrl}/perfil/assinatura/historico`);
  if (historicoRes.status === 200) pass("rota /perfil/assinatura/historico responde 200 (SPA)");
  else fail("rota historico", `status=${historicoRes.status}`);

  const jwt = await resolveJwt();
  if (!jwt) {
    fail("JWT teste", "não autenticou — APIs UI não validadas");
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${jwt}` };

  const timelineRes = await fetch(`${backendUrl}/api/billing/timeline?limit=30`, { headers });
  const timelineBody = await timelineRes.json();
  if (timelineRes.status === 200 && Array.isArray(timelineBody?.timeline)) {
    const hasConfirmed = timelineBody.timeline.some((e) => String(e?.event_type) === "PAYMENT_CONFIRMED");
    pass(`API timeline OK (${timelineBody.timeline.length} eventos${hasConfirmed ? ", PAYMENT_CONFIRMED presente" : ""})`);
    if (!hasConfirmed) fail("timeline PAYMENT_CONFIRMED real", "nenhum evento confirmado no usuário de teste");
  } else {
    fail("API timeline", JSON.stringify(timelineBody));
  }

  const healthRes = await fetch(`${backendUrl}/api/billing/revenue-health`, { headers });
  const healthBody = await healthRes.json();
  if (healthRes.status === 200 && healthBody?.revenue_health?.health_level) {
    pass(`API revenue_health OK (${healthBody.revenue_health.health_level})`);
  } else {
    fail("API revenue_health", JSON.stringify(healthBody));
  }

  const notifyRes = await fetch(`${backendUrl}/api/billing/notifications`, { headers });
  const notifyBody = await notifyRes.json();
  if (notifyRes.status === 200 && Array.isArray(notifyBody?.notifications)) {
    pass(`API notifications OK (${notifyBody.notifications.length} dispatches)`);
  } else {
    fail("API notifications", JSON.stringify(notifyBody));
  }

  const paymentsRes = await fetch(`${backendUrl}/api/billing/payments`, { headers });
  const paymentsBody = await paymentsRes.json();
  if (paymentsRes.status === 200 && Array.isArray(paymentsBody?.payments)) {
    pass(`API payments/histórico preservado (${paymentsBody.payments.length} linhas)`);
  } else {
    fail("API payments", JSON.stringify(paymentsBody));
  }

  console.log("\n--- UI manual / browser ---");
  console.log(`Abrir: ${frontendUrl}/perfil/assinatura/historico`);
  console.log("Validar: filtros, Ver detalhes, mobile sem overflow");

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:")).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
