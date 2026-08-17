#!/usr/bin/env node
/**
 * S5.3 — Registro Oficial de Canais — testes de unidade (sem rede/DB).
 *   node scripts/test_channel_registry_unit.mjs
 *
 * Cobre: contrato por canal, status, capacidades, disponível/suportado,
 * resolução de alias, filtro de canais registrados/disponíveis, e a
 * compatibilidade do catálogo da S5.2 (visão derivada do Registro).
 */

const {
  S7_CHANNEL_REGISTRY,
  S7_CHANNEL_TYPE,
  S7_CHANNEL_STATUS,
  S7_CHANNEL_DELIVERY_MODE,
  resolveCanonicalChannelCode,
  getChannelDefinition,
  isRegisteredChannel,
  isChannelSupported,
  isChannelAvailable,
  getChannelCapabilities,
  listRegisteredChannels,
  listAvailableChannels,
  listChannelsByStatus,
  filterRegisteredAvailableChannels,
} = await import("../src/domain/notifications/central/channels/channelRegistry.js");

const {
  S7_DISPATCH_CHANNEL_CATALOG,
  isChannelSupportedNow,
  listSupportedChannels,
  routeChannels,
  resolveCanonicalChannel,
} = await import("../src/domain/notifications/central/dispatcherCentral/channelCatalog.js");

/** @type {string[]} */
const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

// ----------------------------------------------------------------------------
// 1. Os 7 canais oficiais estão registrados
// ----------------------------------------------------------------------------
{
  const expected = ["in_app", "email", "whatsapp", "push", "popup", "banner", "webhook"];
  for (const code of expected) {
    assert(`registro: ${code} existe`, isRegisteredChannel(code) === true);
  }
  assert("registro: total = 7", listRegisteredChannels().length === 7);
}

// ----------------------------------------------------------------------------
// 2. Contrato por canal (campos obrigatórios)
// ----------------------------------------------------------------------------
{
  const requiredKeys = ["code", "name", "type", "status", "available", "supported", "delivery_mode", "aliases", "capabilities"];
  let allHaveContract = true;
  for (const def of Object.values(S7_CHANNEL_REGISTRY)) {
    for (const k of requiredKeys) {
      if (!(k in def)) allHaveContract = false;
    }
  }
  assert("contrato: todos os canais têm o contrato completo", allHaveContract);

  const wpp = getChannelDefinition("whatsapp");
  assert("contrato: whatsapp nome", wpp.name === "WhatsApp");
  assert("contrato: whatsapp type external", wpp.type === S7_CHANNEL_TYPE.EXTERNAL);
  assert("contrato: whatsapp status ativo", wpp.status === S7_CHANNEL_STATUS.ATIVO);
  assert("contrato: whatsapp delivery async", wpp.delivery_mode === S7_CHANNEL_DELIVERY_MODE.ASYNC);

  const inApp = getChannelDefinition("in_app");
  assert("contrato: in_app é a Central Sininho", inApp.name === "Central Sininho");
  assert("contrato: in_app delivery immediate", inApp.delivery_mode === S7_CHANNEL_DELIVERY_MODE.IMMEDIATE);
}

// ----------------------------------------------------------------------------
// 3. Status / disponibilidade / suporte
// ----------------------------------------------------------------------------
{
  assert("status: in_app/email/whatsapp ativos", isChannelAvailable("in_app") && isChannelAvailable("email") && isChannelAvailable("whatsapp"));
  assert("status: push futuro não disponível", isChannelAvailable("push") === false);
  assert("status: push é reconhecido (supported)", isChannelSupported("push") === true);
  assert("status: disponíveis = 3", listAvailableChannels().length === 3);
  assert("status: futuros = push/popup/banner/webhook", listChannelsByStatus("futuro").length === 4);
  assert("status: registrado mas inexistente", isRegisteredChannel("telegram") === false);
}

// ----------------------------------------------------------------------------
// 4. Capacidades
// ----------------------------------------------------------------------------
{
  const emailCaps = getChannelCapabilities("email");
  assert("caps: email assíncrono", emailCaps.async_delivery === true);
  assert("caps: email precisa fila", emailCaps.needs_queue === true);
  assert("caps: email precisa destinatário", emailCaps.needs_recipient === true);
  assert("caps: email suporta template", emailCaps.supports_template === true);
  assert("caps: email suporta histórico", emailCaps.supports_history === true);

  const inAppCaps = getChannelCapabilities("in_app");
  assert("caps: in_app entrega imediata", inAppCaps.immediate_delivery === true);
  assert("caps: in_app não precisa fila", inAppCaps.needs_queue === false);

  assert("caps: canal inexistente = null", getChannelCapabilities("telegram") === null);
}

// ----------------------------------------------------------------------------
// 5. Resolução de alias
// ----------------------------------------------------------------------------
{
  assert("alias: sininho → in_app", resolveCanonicalChannelCode("sininho") === "in_app");
  assert("alias: zapi → whatsapp", resolveCanonicalChannelCode("ZAPI") === "whatsapp");
  assert("alias: e-mail → email", resolveCanonicalChannelCode("e-mail") === "email");
  assert("alias: desconhecido → null", resolveCanonicalChannelCode("xyz") === null);
}

// ----------------------------------------------------------------------------
// 6. Filtro de governança (Dispatcher só usa registrados+disponíveis)
// ----------------------------------------------------------------------------
{
  const f = filterRegisteredAvailableChannels(["in_app", "email", "push", "telegram", "sininho"]);
  assert("filtro: allowed = in_app/email (sininho dedup p/ in_app)", f.allowed.includes("in_app") && f.allowed.includes("email"));
  assert("filtro: in_app não duplica via alias", f.allowed.filter((c) => c === "in_app").length === 1);
  assert("filtro: push rejeitado (futuro)", f.rejected.includes("push"));
  assert("filtro: telegram rejeitado (não registrado)", f.rejected.includes("telegram"));
}

// ----------------------------------------------------------------------------
// 7. Catálogo S5.2 = visão derivada do Registro (compatibilidade)
// ----------------------------------------------------------------------------
{
  assert("compat: catálogo derivado tem 7 entradas", Object.keys(S7_DISPATCH_CHANNEL_CATALOG).length === 7);
  assert("compat: isChannelSupportedNow(in_app)", isChannelSupportedNow("in_app") === true);
  assert("compat: isChannelSupportedNow(push) false", isChannelSupportedNow("push") === false);
  assert("compat: listSupportedChannels = 3", listSupportedChannels().length === 3);
  assert("compat: resolveCanonicalChannel(sininho)=in_app", resolveCanonicalChannel("sininho") === "in_app");
  assert("compat: email delivery_mode legado = queued", S7_DISPATCH_CHANNEL_CATALOG.email.delivery_mode === "queued");
  assert("compat: in_app delivery_mode legado = immediate", S7_DISPATCH_CHANNEL_CATALOG.in_app.delivery_mode === "immediate");

  const routed = routeChannels(["sininho", "email", "push", "telegram"]);
  assert("compat: routeChannels routed in_app+email", routed.routed.includes("in_app") && routed.routed.includes("email"));
  assert("compat: routeChannels deferred push", routed.deferred.includes("push"));
  assert("compat: routeChannels unknown telegram", routed.unknown.includes("telegram"));
}

// ----------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  console.error(`\n${passed} passaram, ${failures.length} falharam.`);
  process.exit(1);
}
console.log(`✅ S5.3 Registro Oficial de Canais — ${passed} asserts OK.`);
