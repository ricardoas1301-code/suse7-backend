#!/usr/bin/env node
/**
 * S5.13 — Fale Conosco no Motor Central — testes de unidade (sem rede).
 */

const {
  S7_FALE_CONOSCO_MOTOR_PHASE,
  S7_FALE_CONOSCO_PUBLIC_API_PATH,
  S7_FALE_CONOSCO_FLOW,
  getOfficialFaleConoscoMotorSnapshot,
  evaluateOfficialFaleConoscoMotorIntegration,
  describeFaleConoscoMotorRedundancyCandidates,
  validateFaleConoscoContactInput,
  renderFaleConoscoTeamEmail,
  renderFaleConoscoConfirmationEmail,
  getOfficialEmailChannelSnapshot,
  isFaleConoscoDeliveryConfirmed,
  evaluateFaleConoscoLegOutcome,
  normalizeFaleConoscoContactBody,
  S7_FALE_CONOSCO_CONTACT_FIELDS,
} = await import("../src/domain/notifications/central/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("phase S5.13", S7_FALE_CONOSCO_MOTOR_PHASE === "S5.13");
assert("api path", S7_FALE_CONOSCO_PUBLIC_API_PATH === "/api/public/fale-conosco/contact");
assert("flow types", S7_FALE_CONOSCO_FLOW.TYPE_TEAM === "FALE_CONOSCO_TEAM");
assert(
  "contact fields edge contract",
  S7_FALE_CONOSCO_CONTACT_FIELDS.join(",") === "name,email,subject,message"
);

const normalized = normalizeFaleConoscoContactBody({
  name: "  Rico  ",
  email: "Rico@Test.COM",
  subject: "Suporte técnico",
  message: "Olá",
});
assert("normalize name", normalized.name === "Rico");
assert("normalize email lower", normalized.email === "rico@test.com");
assert("normalize subject", normalized.subject === "Suporte técnico");

const snap = getOfficialFaleConoscoMotorSnapshot();
assert("motor single source", snap.motor_central_single_source === true);
assert("no parallel", snap.parallel_motor === false);
assert("ux unchanged", snap.user_ux_unchanged === true);
assert("pipeline dispatcher", snap.pipeline_stages.includes("central_dispatcher"));
assert("inbox email", snap.runtime?.inbox_email === "contato@suse7.com.br");

const emailSnap = getOfficialEmailChannelSnapshot();
assert("email fale conosco integrated", emailSnap.fale_conosco?.integrated === true);
assert("email fale conosco S5.13", emailSnap.fale_conosco?.motor_phase === "S5.13");

const evalSnap = evaluateOfficialFaleConoscoMotorIntegration();
assert("integration ok", evalSnap.ok === true);

const invalid = validateFaleConoscoContactInput({ name: "", email: "", subject: "", message: "" });
assert("validation incomplete", invalid.ok === false && invalid.error === "Campos incompletos.");

const valid = validateFaleConoscoContactInput({
  name: "Rico",
  email: "rico@test.com",
  subject: "Suporte técnico",
  message: "Olá equipe",
});
assert("validation ok", valid.ok === true);

const team = renderFaleConoscoTeamEmail({
  contact_name: "Rico",
  contact_email: "rico@test.com",
  contact_subject: "Suporte",
  contact_message: "Teste",
});
assert("team subject", team.subject.includes("[Fale Conosco]"));
assert("team html", team.html.includes("Fale Conosco"));

const conf = renderFaleConoscoConfirmationEmail({
  contact_name: "Rico",
  contact_subject: "Suporte",
});
assert("confirmation subject", conf.subject === "Recebemos sua mensagem — Suse7");
assert("confirmation no cta button", !conf.html.includes("Ver detalhes no Suse7"));

const redundancy = describeFaleConoscoMotorRedundancyCandidates();
assert("redundancy documented", redundancy.some((r) => r.id.includes("edge")));

assert(
  "delivery confirmed resend",
  isFaleConoscoDeliveryConfirmed({
    dispatch_id: "d1",
    outbox_status: "sent",
    provider_message_id: "re_abc123",
    metadata: { provider: "resend", simulated: false },
  })
);
assert(
  "delivery rejects mock",
  !isFaleConoscoDeliveryConfirmed({
    dispatch_id: "d1",
    outbox_status: "sent",
    provider_message_id: "s7_mock_x",
    metadata: { provider: "mock", simulated: true },
  })
);

const failedLeg = evaluateFaleConoscoLegOutcome({
  ok: true,
  dispatch_id: "d2",
  outbox_status: "pending",
  last_error: "EMAIL_PROVIDER_NOT_CONFIGURED",
  metadata: { simulated: false },
});
assert("leg outcome email not configured", failedLeg.reason === "EMAIL_PROVIDER_NOT_CONFIGURED");

const okLeg = evaluateFaleConoscoLegOutcome({
  ok: true,
  dispatch_id: "d3",
  outbox_status: "sent",
  provider_message_id: "re_live",
  metadata: { provider: "resend" },
});
assert("leg outcome accepts live", okLeg.delivered === true);

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.13 Fale Conosco Motor Central — ${passed} asserts OK.`);
