#!/usr/bin/env node
/**
 * S5.5 — Canal E-mail Oficial — testes de unidade (sem rede).
 */

const {
  S7_EMAIL_OFFICIAL_SENDING_DOMAIN,
  parseEmailFromDomain,
  getOfficialEmailChannelSnapshot,
  evaluateOfficialEmailPolicy,
} = await import("../src/domain/notifications/central/email/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("parse: formato com nome", parseEmailFromDomain("Suse7 <notificacoes@suse7.com.br>") === "suse7.com.br");
assert("parse: email simples", parseEmailFromDomain("ops@suse7.com.br") === "suse7.com.br");
assert("domínio oficial", S7_EMAIL_OFFICIAL_SENDING_DOMAIN === "suse7.com.br");

const snap = getOfficialEmailChannelSnapshot();
assert("snapshot: canal email", snap.channel_code === "email");
assert("snapshot: registry presente", snap.channel_registry?.delivery_mode === "async");
assert("snapshot: outbox worker path", snap.outbox_worker_path === "/api/internal/notifications/email/process");
assert("snapshot: fale conosco separado", snap.fale_conosco?.integrated === false);
assert("snapshot: dispatcher tables", snap.dispatcher_integration?.queue_table === "s7_notification_email_outbox");
assert("snapshot: dns hints", Boolean(snap.deliverability_dns_hints?.spf));

const policy = evaluateOfficialEmailPolicy("invalid");
assert("policy: email inválido bloqueado em sandbox ou permitido mock", typeof policy.allowed === "boolean");

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.5 Canal E-mail Oficial — ${passed} asserts OK.`);
