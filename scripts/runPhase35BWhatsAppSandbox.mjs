#!/usr/bin/env node
/**
 * S7 Mission Control — Fase 3.5B — WhatsApp Sandbox / Test Lab
 *
 * S7_WHATSAPP_MODE=dev_sandbox
 * S7_WHATSAPP_SANDBOX_WHITELIST=5511999999999
 *
 * node scripts/runPhase35BWhatsAppSandbox.mjs
 */

process.env.S7_WHATSAPP_MODE = process.env.S7_WHATSAPP_MODE || "dev_sandbox";
process.env.S7_WHATSAPP_SANDBOX_WHITELIST =
  process.env.S7_WHATSAPP_SANDBOX_WHITELIST || "5511999999999";

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import {
  purgeRecipientsByDestinationHints,
  resolveSellerIdByEmail,
} from "./lib/s7NotificationTestIsolation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const SANDBOX_PHONE = String(process.env.S7_WHATSAPP_SANDBOX_WHITELIST || "5511999999999")
  .replace(/\D/g, "")
  .slice(0, 15);
const testSellerEmail =
  process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";

const SCENARIOS = [
  { key: "billing_confirmed", label: "Billing — pagamento confirmado", category: "BILLING", type: "PAYMENT_CONFIRMED", payload: { plan_name: "Plano Pro (sandbox 3.5B)" } },
  { key: "billing_pending", label: "Billing — pagamento pendente", category: "BILLING", type: "PAYMENT_FAILED", payload: { plan_name: "Plano Pro (sandbox 3.5B)" } },
  { key: "billing_renewal_upcoming", label: "Billing — renovação próxima", category: "BILLING", type: "RENEWAL_COMPLETED", payload: { plan_name: "Plano Pro (sandbox 3.5B)" } },
  { key: "billing_grace", label: "Billing — período de carência", category: "BILLING", type: "ENTERED_GRACE", payload: { plan_name: "Plano Pro (sandbox 3.5B)", grace_ends_at: "30/06/2026" } },
  { key: "sales_loss", label: "Vendas — prejuízo", category: "PROFIT", type: "NEGATIVE_MARGIN", payload: { product_name: "Kit Premium ML" } },
  { key: "sales_low_margin", label: "Vendas — margem baixa", category: "INVENTORY", type: "LOW_STOCK", payload: { product_name: "SKU Margem Baixa" } },
  { key: "marketplace_shipping", label: "Marketplace — frete", category: "MARKETPLACE", type: "PRICE_CHANGED", payload: { marketplace_name: "Mercado Livre" } },
  { key: "marketplace_fee", label: "Marketplace — taxa", category: "MARKETPLACE", type: "FEE_CHANGED", payload: { marketplace_name: "Mercado Livre" } },
  { key: "account_critical", label: "Conta — saúde crítica", category: "ACCOUNT_HEALTH", type: "MARKETPLACE_DISCONNECTED", payload: { marketplace_name: "Mercado Livre" } },
  { key: "sync_failed", label: "Sync falhou", category: "SYNC", type: "SYNC_FAILED", payload: {} },
  { key: "system_alert", label: "Sistema — alerta", category: "SYSTEM", type: "SYSTEM_ALERT", payload: { alert_message: "Observabilidade DEV (sandbox 3.5B)." } },
];

const WA_TEMPLATES = [
  ["billing.payment.confirmed", "BILLING", "PAYMENT_CONFIRMED", "Pagamento confirmado", "Seu pagamento do plano {{plan_name}} foi confirmado."],
  ["billing.payment.failed", "BILLING", "PAYMENT_FAILED", "Pagamento pendente", "Pagamento do plano {{plan_name}} está pendente. Regularize no painel."],
  ["billing.renewal.completed", "BILLING", "RENEWAL_COMPLETED", "Renovação próxima", "A renovação do plano {{plan_name}} está se aproximando."],
  ["billing.grace.started", "BILLING", "ENTERED_GRACE", "Período de carência", "Carência no plano {{plan_name}} até {{grace_ends_at}}."],
  ["profit.negative.margin", "PROFIT", "NEGATIVE_MARGIN", "Prejuízo na venda", "Venda com margem negativa em {{product_name}}."],
  ["inventory.low.stock", "INVENTORY", "LOW_STOCK", "Margem em atenção", "Indicadores de margem ou estoque em {{product_name}}."],
  ["marketplace.price.changed", "MARKETPLACE", "PRICE_CHANGED", "Frete alterado", "Alteração de frete no {{marketplace_name}}."],
  ["marketplace.fee.changed", "MARKETPLACE", "FEE_CHANGED", "Taxa alterada", "Alteração de taxa no {{marketplace_name}}."],
  ["account.marketplace.disconnected", "ACCOUNT_HEALTH", "MARKETPLACE_DISCONNECTED", "Conta crítica", "Integração {{marketplace_name}} precisa de atenção."],
  ["sync.failed", "SYNC", "SYNC_FAILED", "Sync falhou", "Sincronização não concluída. Tente novamente no Suse7."],
  ["system.alert", "SYSTEM", "SYSTEM_ALERT", "Alerta operacional", "{{alert_message}}"],
];

async function ensureWhatsAppTemplates(sb) {
  for (const [key, cat, type, subject, body] of WA_TEMPLATES) {
    await sb.from("s7_notification_templates").upsert(
      {
        template_key: key,
        category_code: cat,
        type_key: type,
        channel: "whatsapp",
        locale: "pt-BR",
        priority: "normal",
        subject_template: subject,
        body_template: body,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "template_key,channel,locale" }
    );
  }
}

async function prepareSandbox(sb, sellerId, runToken) {
  await purgeRecipientsByDestinationHints(sb, sellerId, [`p35b.${runToken}`, SANDBOX_PHONE]);

  const { data: others } = await sb
    .from("s7_notification_recipients")
    .select("id, is_active")
    .eq("seller_id", sellerId)
    .eq("channel", "whatsapp");

  const paused = [];
  for (const row of others ?? []) {
    if (row.is_active) {
      paused.push({ id: String(row.id), wasActive: true });
      await sb.from("s7_notification_recipients").update({ is_active: false }).eq("id", row.id);
    }
  }

  const groupId = randomUUID();
  const { data: inserted } = await sb
    .from("s7_notification_recipients")
    .insert({
      seller_id: sellerId,
      channel: "whatsapp",
      destination: SANDBOX_PHONE,
      label: `Sandbox 3.5B ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
    })
    .select("id, recipient_group_id")
    .single();

  for (const s of SCENARIOS) {
    await sb.from("s7_notification_event_delivery_rules").upsert(
      {
        seller_id: sellerId,
        category_code: s.category,
        type_key: s.type,
        channel: "whatsapp",
        recipient_group_id: inserted.recipient_group_id ?? groupId,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "seller_id,category_code,type_key,channel,recipient_group_id" }
    );
  }

  return { groupId: inserted.recipient_group_id ?? groupId, paused };
}

function buildCopyAnalysis(rows) {
  const lines = [
    "# Fase 3.5B — Análise de copy (WhatsApp sandbox)",
    "",
    "## Resumo",
    `- Cenários: ${rows.length}`,
    `- Modo: dev_sandbox (sem envio real)`,
    `- Ideal: até 500 caracteres por mensagem`,
    "",
    "## Por cenário",
    "",
  ];

  for (const r of rows) {
    lines.push(`### ${r.label}`);
    lines.push(`- Assunto lógico: ${r.logical_subject}`);
    lines.push(`- Caracteres: ${r.char_count}${r.over_ideal_length ? " ⚠️ acima do ideal" : ""}`);
    lines.push(`- CTA: ${r.cta_href}`);
    lines.push("");
    lines.push("```");
    lines.push(r.message_text);
    lines.push("```");
    lines.push("");
  }

  lines.push("## Refinos recomendados");
  lines.push("- Manter título em uma linha (emoji + Suse7).");
  lines.push("- Resumo em uma frase; evitar repetir o título no corpo.");
  lines.push("- CTA sempre `Abra:` + URL absoluta (mobile-friendly).");
  lines.push("- Dark mode: texto puro — OK.");
  lines.push("- Billing: tom calmo em confirmação; urgência só em falha/carência.");

  return lines.join("\n");
}

async function main() {
  console.log("=== S7 Fase 3.5B — WhatsApp Sandbox / Test Lab ===\n");

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("SUPABASE_URL / SERVICE_ROLE ausentes.");
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const runToken = String(Date.now());
  const outDir = resolve(root, "scripts", "output", "phase35b", runToken);
  await mkdir(outDir, { recursive: true });

  const {
    getWhatsAppSandboxWhitelist,
    isDevSandboxWhatsAppMode,
  } = await import("../src/domain/notifications/central/whatsapp/whatsappSandboxPolicy.js");
  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { processWhatsAppOutbox } = await import(
    "../src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js"
  );
  const { sendS7WhatsApp, isRealWhatsAppProviderConfigured } = await import(
    "../src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js"
  );

  const sellerId = await resolveSellerIdByEmail(sb, testSellerEmail);
  if (!sellerId) process.exit(1);

  await ensureWhatsAppTemplates(sb);
  const { paused } = await prepareSandbox(sb, sellerId, runToken);

  const blockedProbe = await sendS7WhatsApp({
    to: "5511888000000",
    message: "teste bloqueio",
  });
  console.log(
    blockedProbe.blocked ? "✓ whitelist bloqueou número não autorizado" : "✗ deveria bloquear"
  );

  const reportRows = [];
  let generated = 0;
  let simulated = 0;
  let failed = 0;

  for (const scenario of SCENARIOS) {
    const idem = `p35b.${runToken}.${scenario.key}`;
    const pub = await publishNotificationEvent(sb, {
      seller_id: sellerId,
      category: scenario.category,
      type: scenario.type,
      idempotency_key: idem,
      payload: scenario.payload,
      source_module: "phase35b_sandbox",
      force_redispatch: true,
    });

    const wa = (pub.dispatches?.dispatches ?? []).find((d) => d.channel === "whatsapp");
    const dispatchId = String(wa?.dispatchId ?? "");
    if (!pub.ok || !wa || !dispatchId) {
      failed += 1;
      console.log(`✗ ${scenario.key}`);
      continue;
    }

    generated += 1;
    await processWhatsAppOutbox(sb, { dispatchId });

    const { data: outbox } = await sb
      .from("s7_notification_whatsapp_outbox")
      .select("message_text, status, metadata, provider_message_id")
      .eq("dispatch_id", dispatchId)
      .maybeSingle();

    const meta = outbox?.metadata ?? {};
    const isSim =
      meta.simulated === true ||
      String(outbox?.provider_message_id ?? "").startsWith("s7_whatsapp_mock");
    if (outbox?.status === "sent" && isSim) simulated += 1;
    else failed += 1;

    const logicalSubject = String(meta.logical_subject ?? scenario.label);
    const charCount = Number(meta.char_count ?? String(outbox?.message_text ?? "").length);
    const messageText = String(outbox?.message_text ?? "");

    const txtPath = resolve(outDir, `${scenario.key}.txt`);
    await writeFile(txtPath, messageText, "utf8");

    reportRows.push({
      key: scenario.key,
      label: scenario.label,
      category: scenario.category,
      type: scenario.type,
      logical_subject: logicalSubject,
      message_text: messageText,
      cta_href: meta.cta_href ?? meta.deep_link ?? "",
      deep_link: meta.deep_link ?? "",
      char_count: charCount,
      over_ideal_length: charCount > 500,
      outbox_status: outbox?.status,
      simulated: isSim,
      provider_message_id: outbox?.provider_message_id,
      preview_txt: `scripts/output/phase35b/${runToken}/${scenario.key}.txt`,
    });

    console.log(
      `${outbox?.status === "sent" ? "✓" : "✗"} ${scenario.key} — ${charCount} chars (simulado)`
    );
  }

  await purgeRecipientsByDestinationHints(sb, sellerId, [`p35b.${runToken}`, SANDBOX_PHONE]);
  for (const row of paused) {
    if (row.wasActive) await sb.from("s7_notification_recipients").update({ is_active: true }).eq("id", row.id);
  }

  const report = {
    run_token: runToken,
    sandbox_phone: SANDBOX_PHONE,
    whatsapp_mode: process.env.S7_WHATSAPP_MODE,
    whitelist: getWhatsAppSandboxWhitelist(),
    dev_sandbox: isDevSandboxWhatsAppMode(),
    real_provider: isRealWhatsAppProviderConfigured(),
    generated,
    simulated,
    blocked_probe: blockedProbe.blocked === true,
    failed,
    rows: reportRows,
    output_dir: `scripts/output/phase35b/${runToken}`,
  };

  await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(resolve(outDir, "COPY_ANALYSIS.md"), buildCopyAnalysis(reportRows), "utf8");

  console.log("\n--- Relatório 3.5B ---");
  console.log(`Gerados: ${generated} | Simulados: ${simulated} | Falhas: ${failed}`);
  console.log(`Whitelist: ${getWhatsAppSandboxWhitelist().join(", ")}`);
  console.log(`Previews: scripts/output/phase35b/${runToken}/`);

  if (failed > 0 || !blockedProbe.blocked) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
