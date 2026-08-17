#!/usr/bin/env node
/**
 * S5.4 — Central de Templates — testes de unidade (sem rede/DB real).
 *   node scripts/test_templates_central_unit.mjs
 *
 * Cobre: contrato + validação, status/tipo, variáveis (escopos/precedência),
 * engine de renderização (placeholders/missing), preview por canal,
 * agrupamento por canal (registry) e listTemplates com Supabase fake.
 */

const {
  S7_TEMPLATE_STATUS,
  S7_TEMPLATE_TYPE,
  isValidTemplateStatus,
  isValidTemplateType,
  toTemplateContract,
  validateTemplateContract,
  S7_TEMPLATE_VARIABLE_SCOPE,
  buildTemplateVariableContext,
  buildSampleVariables,
  normalizeVariablesSchema,
  extractTemplatePlaceholders,
  renderTemplate,
  previewTemplate,
  groupTemplatesByChannel,
  listTemplates,
} = await import("../src/domain/notifications/central/templates/index.js");

/** @type {string[]} */
const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

// ----------------------------------------------------------------------------
// 1. Contrato + validação
// ----------------------------------------------------------------------------
{
  const c = toTemplateContract({
    template_key: "demo.key",
    channel: "whatsapp",
    version: 2,
    status: "active",
    subject_template: "",
    body_template: "Olá {{seller_name}}",
  });
  assert("contrato: normaliza key/canal", c.template_key === "demo.key" && c.channel === "whatsapp");
  assert("contrato: versão preservada", c.version === 2);
  assert("contrato: locale default pt-BR", c.locale === "pt-BR");

  assert("validação: ok", validateTemplateContract(c).ok === true);
  assert("validação: sem key", validateTemplateContract({ channel: "email" }).primaryError === "MISSING_TEMPLATE_KEY");
  assert("validação: canal não registrado", validateTemplateContract({ template_key: "x", channel: "telegram" }).errors.includes("UNREGISTERED_CHANNEL"));
  assert("validação: status inválido", validateTemplateContract({ template_key: "x", channel: "email", status: "zzz" }).errors.includes("INVALID_STATUS"));
  assert("validação: versão inválida", validateTemplateContract({ template_key: "x", channel: "email", version: 0 }).errors.includes("INVALID_VERSION"));
}

// ----------------------------------------------------------------------------
// 2. Status / tipo
// ----------------------------------------------------------------------------
{
  assert("status: active válido", isValidTemplateStatus("active") === true);
  assert("status: archived válido", isValidTemplateStatus(S7_TEMPLATE_STATUS.ARCHIVED) === true);
  assert("status: inválido", isValidTemplateStatus("publicado") === false);
  assert("tipo: operational válido", isValidTemplateType(S7_TEMPLATE_TYPE.OPERATIONAL) === true);
  assert("tipo: inválido", isValidTemplateType("promo") === false);
}

// ----------------------------------------------------------------------------
// 3. Variáveis dinâmicas (escopos + precedência)
// ----------------------------------------------------------------------------
{
  const ctx = buildTemplateVariableContext({
    global: { seller_name: "Loja A", marketplace_name: "ML" },
    channel: { seller_name: "Loja A (wpp)" },
    context: { order_id: "123" },
  });
  assert("vars: precedência channel > global", ctx.seller_name === "Loja A (wpp)");
  assert("vars: global presente", ctx.marketplace_name === "ML");
  assert("vars: context presente", ctx.order_id === "123");

  const descriptors = normalizeVariablesSchema(["seller_name", { key: "order_id", scope: "context", example: "999" }]);
  assert("vars: schema normalizado", descriptors.length === 2 && descriptors[0].key === "seller_name");
  assert("vars: escopo default context", descriptors[0].scope === S7_TEMPLATE_VARIABLE_SCOPE.CONTEXT);

  const sample = buildSampleVariables(descriptors);
  assert("vars: sample com example", sample.order_id === "999");
  assert("vars: sample placeholder p/ sem example", sample.seller_name === "{{seller_name}}");
}

// ----------------------------------------------------------------------------
// 4. Engine de renderização
// ----------------------------------------------------------------------------
{
  assert("render: extrai placeholders únicos", JSON.stringify(extractTemplatePlaceholders("{{a}} {{b}} {{a}}")) === JSON.stringify(["a", "b"]));

  const r = renderTemplate(
    { subject_template: "Oi {{seller_name}}", body_template: "Pedido {{order_id}} de {{seller_name}}" },
    { seller_name: "Loja A", order_id: "777" }
  );
  assert("render: subject resolvido", r.subject === "Oi Loja A");
  assert("render: body resolvido", r.body === "Pedido 777 de Loja A");
  assert("render: sem missing", r.ok === true && r.missing_variables.length === 0);

  const r2 = renderTemplate({ body_template: "Oi {{seller_name}}" }, {});
  assert("render: detecta missing", r2.ok === false && r2.missing_variables.includes("seller_name"));
  assert("render: missing vira string vazia", r2.body === "Oi ");
}

// ----------------------------------------------------------------------------
// 5. Preview por canal
// ----------------------------------------------------------------------------
{
  const pv = previewTemplate({
    channel: "whatsapp",
    subject_template: "",
    body_template: "Olá {{seller_name}}, pedido {{order_id}}",
    variables_schema: [{ key: "seller_name", example: "Loja X" }, { key: "order_id", example: "555" }],
  });
  assert("preview: canal whatsapp suportado/disponível", pv.channel_supported === true && pv.channel_available === true);
  assert("preview: delivery async", pv.delivery_mode === "async");
  assert("preview: body com sample", pv.body === "Olá Loja X, pedido 555");
  assert("preview: ok sem missing", pv.ok === true);

  const pvFuturo = previewTemplate({ channel: "banner", body_template: "x" });
  assert("preview: banner reconhecido mas não disponível", pvFuturo.channel_supported === true && pvFuturo.channel_available === false);
}

// ----------------------------------------------------------------------------
// 6. Agrupamento por canal (inclui canais sem templates)
// ----------------------------------------------------------------------------
{
  const grouped = groupTemplatesByChannel([
    toTemplateContract({ template_key: "a", channel: "whatsapp" }),
    toTemplateContract({ template_key: "b", channel: "email" }),
    toTemplateContract({ template_key: "c", channel: "whatsapp" }),
  ]);
  assert("group: whatsapp com 2", grouped.whatsapp.count === 2);
  assert("group: email com 1", grouped.email.count === 1);
  assert("group: in_app presente vazio", grouped.in_app && grouped.in_app.count === 0);
  assert("group: banner presente vazio", grouped.banner && grouped.banner.count === 0);
}

// ----------------------------------------------------------------------------
// 7. listTemplates com Supabase fake
// ----------------------------------------------------------------------------
{
  const rows = [
    { template_key: "a", channel: "email", status: "active", locale: "pt-BR", version: 1 },
    { template_key: "b", channel: "email", status: "active", locale: "pt-BR", version: 3 },
  ];
  const supa = {
    from(table) {
      if (table !== "s7_notification_templates") throw new Error(`tabela inesperada: ${table}`);
      const builder = {
        _rows: rows,
        select() { return builder; },
        eq() { return builder; },
        then: undefined,
      };
      // torna "awaitable" no padrão supabase (resolve no await direto)
      return {
        select() {
          return {
            eq() { return this; },
            async then(resolve) { resolve({ data: rows, error: null }); },
          };
        },
      };
    },
  };

  const out = await listTemplates(supa, { channel: "email" });
  assert("list: ok", out.ok === true);
  assert("list: 2 contratos normalizados", out.templates.length === 2 && out.templates[1].version === 3);

  const unknownCh = await listTemplates(supa, { channel: "telegram" });
  assert("list: canal não registrado retorna vazio", unknownCh.ok === true && unknownCh.templates.length === 0);
}

// ----------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  console.error(`\n${passed} passaram, ${failures.length} falharam.`);
  process.exit(1);
}
console.log(`✅ S5.4 Central de Templates — ${passed} asserts OK.`);
