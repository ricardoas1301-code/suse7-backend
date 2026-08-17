#!/usr/bin/env node
/**
 * P_2.8.12F.GA — Aplica no Supabase DEV o card/evento
 * "Compartilhar Relatório de Vendas" (SALES:MANUAL_SALES_REPORT) + templates.
 *
 * Equivalente idempotente à migration:
 *   20260608171000_s7_sales_report_manual_notification_templates.sql
 *
 * Guard-rail: só executa contra o Supabase DEV (confere project ref).
 * NÃO aplicar em produção.
 *
 * Uso: node scripts/applySalesReportNotificationCardDev.mjs
 * Requer: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function loadEnvLocal() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvLocal();

const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const expectedRef = process.env.S7_EXPECTED_SUPABASE_PROJECT_REF?.trim();

if (!url || !key) {
  console.error("FAIL: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios (.env.local)");
  process.exit(1);
}

const refMatch = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url);
const projectRef = refMatch ? refMatch[1] : "(desconhecido)";

console.log("=== Aplicar card MANUAL_SALES_REPORT (Supabase DEV) ===");
console.log(`SUPABASE_URL project ref: ${projectRef}`);
console.log(`S7_EXPECTED_SUPABASE_PROJECT_REF: ${expectedRef ?? "(não definido)"}`);
console.log(`S7_APP_ENV: ${process.env.S7_APP_ENV ?? "(não definido)"}`);

if (expectedRef && projectRef !== expectedRef) {
  console.error(
    `\nFAIL (guard-rail): project ref (${projectRef}) != S7_EXPECTED_SUPABASE_PROJECT_REF (${expectedRef}).` +
      "\nAbort — não vou escrever em um banco que não é o DEV esperado.",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // 1) Categoria SALES (idempotente — não sobrescreve se já existir)
  {
    const { error } = await supabase
      .from("s7_notification_categories")
      .upsert(
        { code: "SALES", label: "Vendas", description: "Pedidos e vendas", sort_order: 40 },
        { onConflict: "code", ignoreDuplicates: true },
      );
    if (error) throw new Error(`categories upsert: ${error.message}`);
    console.log("OK: categoria SALES garantida");
  }

  // 2) Evento MANUAL_SALES_REPORT
  {
    const { error } = await supabase.from("s7_notification_event_types").upsert(
      {
        category_code: "SALES",
        type_key: "MANUAL_SALES_REPORT",
        label: "Compartilhar Relatório de Vendas",
        description: "Acionamento manual pelo seller a partir do modal Relatório de Vendas",
        severity_default: "info",
        is_mandatory: false,
        default_channels: ["whatsapp", "email"],
        supported_channels: ["whatsapp", "email"],
        template_key: "sales.manual.report",
        is_active: true,
      },
      { onConflict: "category_code,type_key" },
    );
    if (error) throw new Error(`event_types upsert: ${error.message}`);
    console.log("OK: evento SALES:MANUAL_SALES_REPORT registrado");
  }

  // 3) Templates WhatsApp + E-mail
  {
    const whatsappBody =
      "📊 Suse7 — Relatório de Vendas\n\n" +
      "Período: {{periodo}}\nConta: {{conta}}\nVendas: {{vendas}}\n\n" +
      "Faturamento: {{faturamento}}\nLucro: {{lucro}}\nMargem: {{margem}}\n\n" +
      "Gerado por Suse7 Precifica\nInteligência em Vendas";
    const emailBody =
      "Olá,\n\nSegue o resumo do Relatório de Vendas:\n\n" +
      "Período: {{periodo}}\nConta: {{conta}}\nVendas: {{vendas}}\n\n" +
      "Faturamento: {{faturamento}}\nLucro: {{lucro}}\nMargem: {{margem}}\n\n" +
      "Gerado por Suse7 Precifica\nInteligência em Vendas";

    const { error } = await supabase.from("s7_notification_templates").upsert(
      [
        {
          template_key: "sales.manual.report",
          category_code: "SALES",
          type_key: "MANUAL_SALES_REPORT",
          channel: "whatsapp",
          locale: "pt-BR",
          priority: "normal",
          subject_template: "",
          body_template: whatsappBody,
          is_active: true,
        },
        {
          template_key: "sales.manual.report",
          category_code: "SALES",
          type_key: "MANUAL_SALES_REPORT",
          channel: "email",
          locale: "pt-BR",
          priority: "normal",
          subject_template: "Relatório de Vendas — {{periodo}}",
          body_template: emailBody,
          is_active: true,
        },
      ],
      { onConflict: "template_key,channel,locale" },
    );
    if (error) throw new Error(`templates upsert: ${error.message}`);
    console.log("OK: templates sales.manual.report (whatsapp + email)");
  }

  // 4) Readback de validação
  const { data: evt, error: readErr } = await supabase
    .from("s7_notification_event_types")
    .select("category_code, type_key, label, description, supported_channels, is_active")
    .eq("category_code", "SALES")
    .eq("type_key", "MANUAL_SALES_REPORT")
    .maybeSingle();
  if (readErr) throw new Error(`readback: ${readErr.message}`);

  console.log("\n=== Readback ===");
  console.log(JSON.stringify(evt, null, 2));
  console.log(
    evt && evt.is_active
      ? "\nPASS: card 'Compartilhar Relatório de Vendas' disponível na categoria Vendas."
      : "\nFAIL: evento não encontrado/ativo.",
  );
  process.exit(evt && evt.is_active ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e.message ?? e);
  process.exit(1);
});
