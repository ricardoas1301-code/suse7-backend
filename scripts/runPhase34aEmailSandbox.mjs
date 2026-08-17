#!/usr/bin/env node
/**
 * S7 Mission Control — Fase 3.4.A — Validação real de e-mails (sandbox)
 *
 * Uso:
 *   S7_EMAIL_MODE=dev_sandbox S7_EMAIL_PROVIDER=resend RESEND_API_KEY=re_xxx \
 *   node scripts/runPhase34aEmailSandbox.mjs
 *
 * Destinatário autorizado: ricardoas1301@gmail.com (whitelist)
 */

process.env.S7_EMAIL_MODE = process.env.S7_EMAIL_MODE || "dev_sandbox";
process.env.S7_EMAIL_SANDBOX_WHITELIST =
  process.env.S7_EMAIL_SANDBOX_WHITELIST || "ricardoas1301@gmail.com";

import { config as loadEnv } from "dotenv";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
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

const SANDBOX_EMAIL = "ricardoas1301@gmail.com";
const testSellerEmail =
  process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";

/** @type {Array<{ key: string, label: string, category: string, type: string, payload: Record<string, unknown> }>} */
const SCENARIOS = [
  {
    key: "billing_confirmed",
    label: "Billing — pagamento confirmado",
    category: "BILLING",
    type: "PAYMENT_CONFIRMED",
    payload: { plan_name: "Plano Pro (sandbox 3.4.A)" },
  },
  {
    key: "billing_pending",
    label: "Billing — pagamento pendente",
    category: "BILLING",
    type: "PAYMENT_FAILED",
    payload: { plan_name: "Plano Pro (sandbox 3.4.A)" },
  },
  {
    key: "billing_renewal_upcoming",
    label: "Billing — renovação próxima",
    category: "BILLING",
    type: "RENEWAL_COMPLETED",
    payload: { plan_name: "Plano Pro (sandbox 3.4.A)" },
  },
  {
    key: "billing_grace",
    label: "Billing — período de carência",
    category: "BILLING",
    type: "ENTERED_GRACE",
    payload: { plan_name: "Plano Pro (sandbox 3.4.A)", grace_ends_at: "30/06/2026" },
  },
  {
    key: "sales_loss",
    label: "Vendas — venda com prejuízo",
    category: "PROFIT",
    type: "NEGATIVE_MARGIN",
    payload: { product_name: "Kit Premium ML #sandbox" },
  },
  {
    key: "sales_low_margin",
    label: "Vendas — margem baixa",
    category: "INVENTORY",
    type: "LOW_STOCK",
    payload: { product_name: "SKU Margem Baixa #sandbox" },
  },
  {
    key: "marketplace_shipping",
    label: "Marketplace — aumento de frete",
    category: "MARKETPLACE",
    type: "PRICE_CHANGED",
    payload: { marketplace_name: "Mercado Livre" },
  },
  {
    key: "marketplace_fee",
    label: "Marketplace — alteração de taxa",
    category: "MARKETPLACE",
    type: "FEE_CHANGED",
    payload: { marketplace_name: "Mercado Livre" },
  },
  {
    key: "account_critical",
    label: "Conta — saúde crítica",
    category: "ACCOUNT_HEALTH",
    type: "MARKETPLACE_DISCONNECTED",
    payload: { marketplace_name: "Mercado Livre" },
  },
  {
    key: "sync_failed",
    label: "Conta — sincronização falhou",
    category: "SYNC",
    type: "SYNC_FAILED",
    payload: {},
  },
  {
    key: "system_alert",
    label: "Sistema — alerta operacional",
    category: "SYSTEM",
    type: "SYSTEM_ALERT",
    payload: { alert_message: "Rotina de observabilidade executada em DEV (sandbox 3.4.A)." },
  },
];

const EXTRA_TEMPLATES = [
  [
    "billing.payment.generated",
    "BILLING",
    "PAYMENT_GENERATED",
    "Cobrança gerada — {{plan_name}}",
    "Registramos uma nova cobrança do plano {{plan_name}}.",
  ],
  [
    "billing.renewal.completed",
    "BILLING",
    "RENEWAL_COMPLETED",
    "Renovação próxima — {{plan_name}}",
    "A renovação do plano {{plan_name}} está se aproximando.",
  ],
  [
    "profit.negative.margin",
    "PROFIT",
    "NEGATIVE_MARGIN",
    "Venda com prejuízo — {{product_name}}",
    "Identificamos uma venda com margem negativa no item {{product_name}}.",
  ],
  [
    "inventory.low.stock",
    "INVENTORY",
    "LOW_STOCK",
    "Margem ou estoque em atenção — {{product_name}}",
    "O item {{product_name}} merece atenção de margem ou estoque.",
  ],
  [
    "marketplace.price.changed",
    "MARKETPLACE",
    "PRICE_CHANGED",
    "Aumento de frete — {{marketplace_name}}",
    "Detectamos alteração de frete no {{marketplace_name}}.",
  ],
  [
    "marketplace.fee.changed",
    "MARKETPLACE",
    "FEE_CHANGED",
    "Alteração de taxa — {{marketplace_name}}",
    "Houve alteração de taxa no {{marketplace_name}}.",
  ],
  [
    "account.marketplace.disconnected",
    "ACCOUNT_HEALTH",
    "MARKETPLACE_DISCONNECTED",
    "Saúde crítica da conta — {{marketplace_name}}",
    "A integração com {{marketplace_name}} precisa de atenção imediata.",
  ],
  ["sync.failed", "SYNC", "SYNC_FAILED", "Sincronização falhou", "Uma sincronização não foi concluída."],
  [
    "system.alert",
    "SYSTEM",
    "SYSTEM_ALERT",
    "Alerta operacional Suse7",
    "{{alert_message}}",
  ],
];

async function ensureEmailTemplates(sb) {
  for (const [templateKey, category, type, subject, body] of EXTRA_TEMPLATES) {
    const { error } = await sb.from("s7_notification_templates").upsert(
      {
        template_key: templateKey,
        category_code: category,
        type_key: type,
        channel: "email",
        locale: "pt-BR",
        priority: "normal",
        subject_template: subject,
        body_template: body,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "template_key,channel,locale" }
    );
    if (error && error.code !== "42P01") throw error;
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {string} sellerId
 * @param {string} runToken
 */
async function prepareSandboxRecipients(sb, sellerId, runToken) {
  await purgeRecipientsByDestinationHints(sb, sellerId, [`p34a.${runToken}`, SANDBOX_EMAIL]);

  const { data: others } = await sb
    .from("s7_notification_recipients")
    .select("id, destination, is_active")
    .eq("seller_id", sellerId)
    .eq("channel", "email");

  /** @type {Array<{ id: string, wasActive: boolean }>} */
  const paused = [];
  for (const row of others ?? []) {
    if (String(row.destination).toLowerCase() === SANDBOX_EMAIL) continue;
    if (row.is_active) {
      paused.push({ id: String(row.id), wasActive: true });
      await sb.from("s7_notification_recipients").update({ is_active: false }).eq("id", row.id);
    }
  }

  const groupId = randomUUID();
  const { data: inserted, error } = await sb
    .from("s7_notification_recipients")
    .insert({
      seller_id: sellerId,
      channel: "email",
      destination: SANDBOX_EMAIL,
      label: `Sandbox 3.4.A ${runToken}`,
      is_active: true,
      recipient_group_id: groupId,
      metadata: { sandbox: "phase34a", run_token: runToken },
    })
    .select("id, recipient_group_id")
    .single();

  if (error) throw error;

  for (const scenario of SCENARIOS) {
    await sb.from("s7_notification_event_delivery_rules").upsert(
      {
        seller_id: sellerId,
        category_code: scenario.category,
        type_key: scenario.type,
        channel: "email",
        recipient_group_id: inserted.recipient_group_id ?? groupId,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "seller_id,category_code,type_key,channel,recipient_group_id" }
    );
  }

  return { recipientId: inserted.id, groupId: inserted.recipient_group_id ?? groupId, paused };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ paused: Array<{ id: string, wasActive: boolean }> }} state
 */
async function restoreRecipients(sb, state) {
  for (const row of state.paused) {
    if (row.wasActive) {
      await sb.from("s7_notification_recipients").update({ is_active: true }).eq("id", row.id);
    }
  }
}

async function main() {
  console.log("=== S7 Fase 3.4.A — Email Sandbox ===\n");

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceKey) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes.");
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const runToken = String(Date.now());
  const outDir = resolve(root, "scripts", "output", "phase34a", runToken);
  await mkdir(outDir, { recursive: true });

  const { isRealEmailProviderConfigured, canSendRealEmailNow } = await import(
    "../src/domain/notifications/central/email/S7EmailProvider.js"
  );
  const { getEmailSandboxWhitelist, isDevSandboxEmailMode } = await import(
    "../src/domain/notifications/central/email/emailSandboxPolicy.js"
  );
  const { publishNotificationEvent } = await import(
    "../src/domain/notifications/central/events/publishNotificationEvent.js"
  );
  const { processEmailOutbox } = await import(
    "../src/domain/notifications/central/email/processEmailOutbox.js"
  );

  const sellerId = await resolveSellerIdByEmail(sb, testSellerEmail);
  if (!sellerId) {
    console.error(`Seller de teste não encontrado (${testSellerEmail}).`);
    process.exit(1);
  }

  const { error: outboxProbeErr } = await sb
    .from("s7_notification_email_outbox")
    .select("id")
    .limit(1);
  if (outboxProbeErr && (outboxProbeErr.code === "42P01" || outboxProbeErr.code === "PGRST205")) {
    console.error("Tabela s7_notification_email_outbox ausente — aplicar migration 3.4.");
    process.exit(1);
  }

  await ensureEmailTemplates(sb);
  const recipientState = await prepareSandboxRecipients(sb, sellerId, runToken);

  /** @type {Array<Record<string, unknown>>} */
  const reportRows = [];
  let generated = 0;
  let sent = 0;
  let simulated = 0;
  let blocked = 0;
  let failed = 0;

  for (const scenario of SCENARIOS) {
    const idem = `p34a.${runToken}.${scenario.key}`;
    const pub = await publishNotificationEvent(sb, {
      seller_id: sellerId,
      category: scenario.category,
      type: scenario.type,
      idempotency_key: idem,
      payload: scenario.payload,
      source_module: "phase34a_sandbox",
      force_redispatch: true,
    });

    const emailDispatch = (pub.dispatches?.dispatches ?? []).find((d) => d.channel === "email");
    const dispatchId = String(emailDispatch?.dispatchId ?? emailDispatch?.id ?? "");
    if (!pub.ok || !emailDispatch || !dispatchId) {
      reportRows.push({
        ...scenario,
        status: "NOT_GENERATED",
        error: pub.error ?? "no_email_dispatch",
      });
      failed += 1;
      console.log(`✗ ${scenario.key} — não gerou dispatch e-mail`);
      continue;
    }

    generated += 1;
    await processEmailOutbox(sb, { dispatchId });

    const { data: outbox } = await sb
      .from("s7_notification_email_outbox")
      .select("subject, body_html, body_text, status, metadata, provider_message_id, recipient_email")
      .eq("dispatch_id", dispatchId)
      .maybeSingle();

    const { data: dispatch } = await sb
      .from("s7_notification_dispatches")
      .select("status, destination, provider_key")
      .eq("id", dispatchId)
      .maybeSingle();

    const meta = outbox?.metadata && typeof outbox.metadata === "object" ? outbox.metadata : {};
    const providerId = String(outbox?.provider_message_id ?? "");
    const isSim =
      meta.simulated === true ||
      providerId.startsWith("s7_mock") ||
      providerId.startsWith("s7_sandbox_mock");

    if (outbox?.status === "sent") {
      if (isSim) simulated += 1;
      else sent += 1;
    } else {
      failed += 1;
    }

    const subject = String(outbox?.subject ?? "");
    const cta = String(meta.cta_href ?? meta.deep_link ?? "");
    const htmlPath = resolve(outDir, `${scenario.key}.html`);
    if (outbox?.body_html) {
      await writeFile(htmlPath, String(outbox.body_html), "utf8");
    }

    reportRows.push({
      key: scenario.key,
      label: scenario.label,
      category: scenario.category,
      type: scenario.type,
      subject,
      cta_href: cta,
      outbox_status: outbox?.status ?? null,
      dispatch_status: dispatch?.status ?? null,
      destination: dispatch?.destination ?? SANDBOX_EMAIL,
      simulated: isSim,
      provider_message_id: dispatch?.provider_message_id ?? null,
      preview_html: `scripts/output/phase34a/${runToken}/${scenario.key}.html`,
    });

    const deliveryLabel = isSim ? "simulado" : "real";
    console.log(
      `${outbox?.status === "sent" ? "✓" : "✗"} ${scenario.key} — ${subject.slice(0, 70)} (${deliveryLabel})`
    );
  }

  await purgeRecipientsByDestinationHints(sb, sellerId, [`p34a.${runToken}`, SANDBOX_EMAIL]);
  await restoreRecipients(sb, recipientState);

  const report = {
    run_token: runToken,
    sandbox_email: SANDBOX_EMAIL,
    test_seller_email: testSellerEmail,
    seller_id: sellerId,
    email_mode: process.env.S7_EMAIL_MODE,
    whitelist: getEmailSandboxWhitelist(),
    dev_sandbox: isDevSandboxEmailMode(),
    resend_configured: Boolean(process.env.RESEND_API_KEY?.trim()),
    can_send_real: canSendRealEmailNow(),
    is_real_provider_flag: isRealEmailProviderConfigured(),
    generated,
    sent_real: sent,
    simulated,
    blocked,
    failed,
    subjects: reportRows.map((r) => r.subject).filter(Boolean),
    ctas: reportRows.map((r) => ({ key: r.key, cta_href: r.cta_href })),
    rows: reportRows,
    output_dir: `scripts/output/phase34a/${runToken}`,
  };

  await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log("\n--- Relatório 3.4.A ---");
  console.log(`Gerados: ${generated} | Reais: ${sent} | Simulados: ${simulated} | Falhas: ${failed}`);
  console.log(`Whitelist: ${getEmailSandboxWhitelist().join(", ")}`);
  console.log(`Previews HTML: scripts/output/phase34a/${runToken}/`);
  console.log(`Resend: ${report.resend_configured ? "configurado" : "ausente (apenas simulado + HTML local)"}`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
