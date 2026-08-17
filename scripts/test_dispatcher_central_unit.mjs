#!/usr/bin/env node
/**
 * S5.2 — Dispatcher Central — testes de unidade (sem rede/DB real).
 *   node scripts/test_dispatcher_central_unit.mjs
 *
 * Cobre: catálogo/roteador de canais, resumo de status por canal + resultado
 * final, política de retry (backoff), política de fallback (config-driven),
 * constantes de status, e summarizeEventChannelStatus com Supabase fake.
 */

// Env de fallback ANTES de importar (lido no resolve).
process.env.S7_DISPATCH_FALLBACK_WHATSAPP = "email,sininho,push";

const {
  resolveCanonicalChannel,
  isChannelSupportedNow,
  listSupportedChannels,
  routeChannels,
  S7_DISPATCH_FINAL_RESULT,
  resolveFinalResult,
  summarizeChannelStatusFromDispatches,
  summarizeEventChannelStatus,
  resolveDispatchRetryPolicy,
  planDispatchRetry,
  resolveChannelFallbackChain,
  resolveNextFallbackChannel,
} = await import("../src/domain/notifications/central/dispatcherCentral/index.js");

const {
  S7_NOTIFICATION_DISPATCH_STATUS: ST,
  isTerminalDispatchStatus,
  isValidDispatchStatus,
} = await import("../src/domain/notifications/central/constants/dispatchStatus.js");

/** @type {string[]} */
const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

// ----------------------------------------------------------------------------
// 1. Catálogo / roteador de canais
// ----------------------------------------------------------------------------
{
  assert("catalog: alias sininho → in_app", resolveCanonicalChannel("sininho") === "in_app");
  assert("catalog: alias zapi → whatsapp", resolveCanonicalChannel("ZAPI") === "whatsapp");
  assert("catalog: desconhecido → null", resolveCanonicalChannel("telegram") === null);
  assert("catalog: in_app suportado agora", isChannelSupportedNow("in_app") === true);
  assert("catalog: push ainda não suportado", isChannelSupportedNow("push") === false);
  assert("catalog: banner futuro não suportado", isChannelSupportedNow("banner") === false);

  const supported = listSupportedChannels();
  assert("catalog: suportados = in_app/email/whatsapp", supported.length === 3 && supported.includes("whatsapp"));

  const routed = routeChannels(["sininho", "email", "push", "telegram"]);
  assert("router: routed contém in_app+email", routed.routed.includes("in_app") && routed.routed.includes("email"));
  assert("router: deferred contém push", routed.deferred.includes("push"));
  assert("router: unknown contém telegram", routed.unknown.includes("telegram"));
}

// ----------------------------------------------------------------------------
// 2. Resumo de status por canal + resultado final
// ----------------------------------------------------------------------------
{
  assert("final: vazio = empty", resolveFinalResult({}) === S7_DISPATCH_FINAL_RESULT.EMPTY);
  assert("final: só SENT = delivered", resolveFinalResult({ SENT: 2 }) === S7_DISPATCH_FINAL_RESULT.DELIVERED);
  assert("final: SENT+FAILED = partial", resolveFinalResult({ SENT: 1, FAILED: 1 }) === S7_DISPATCH_FINAL_RESULT.PARTIAL);
  assert("final: só FAILED = failed", resolveFinalResult({ FAILED: 3 }) === S7_DISPATCH_FINAL_RESULT.FAILED);
  assert("final: QUEUED presente = in_progress", resolveFinalResult({ SENT: 1, QUEUED: 1 }) === S7_DISPATCH_FINAL_RESULT.IN_PROGRESS);
  assert("final: SKIPPED+DEDUPED = skipped", resolveFinalResult({ SKIPPED: 1, DEDUPED: 2 }) === S7_DISPATCH_FINAL_RESULT.SKIPPED);

  const sum = summarizeChannelStatusFromDispatches([
    { channel: "in_app", status: "SENT" },
    { channel: "email", status: "QUEUED" },
    { channel: "whatsapp", status: "QUEUED" },
  ]);
  assert("summary: 3 canais", Object.keys(sum.channels).length === 3);
  assert("summary: in_app SENT", sum.channels.in_app.status === "SENT");
  assert("summary: final in_progress (há QUEUED)", sum.final_result === S7_DISPATCH_FINAL_RESULT.IN_PROGRESS);
  assert("summary: status_counts QUEUED=2", sum.status_counts.QUEUED === 2);
}

// ----------------------------------------------------------------------------
// 3. Política de retry (backoff + teto)
// ----------------------------------------------------------------------------
{
  const policy = resolveDispatchRetryPolicy("whatsapp");
  assert("retry: defaults maxAttempts=3", policy.maxAttempts === 3);
  assert("retry: base backoff 60s", policy.baseBackoffMs === 60000);

  const r1 = planDispatchRetry({ channel: "whatsapp", attempt: 0, now: 0 });
  assert("retry: 1ª tentativa agenda", r1.shouldRetry === true && r1.nextAttempt === 1);
  assert("retry: delay linear 60s", r1.delayMs === 60000 && r1.nextRetryAt === new Date(60000).toISOString());

  const r2 = planDispatchRetry({ channel: "whatsapp", attempt: 1, now: 0 });
  assert("retry: 2ª tentativa delay 120s", r2.delayMs === 120000);

  const rMax = planDispatchRetry({ channel: "whatsapp", attempt: 3, now: 0 });
  assert("retry: estourou maxAttempts não retenta", rMax.shouldRetry === false && rMax.nextRetryAt === null);
}

// ----------------------------------------------------------------------------
// 4. Política de fallback (config-driven via env)
// ----------------------------------------------------------------------------
{
  const chain = resolveChannelFallbackChain("whatsapp");
  // env = "email,sininho,push" → sininho vira in_app; push não é suportado agora (removido)
  assert("fallback: cadeia = [email, in_app]", chain.chain.join(",") === "email,in_app");
  assert("fallback: habilitado", chain.enabled === true);

  const restricted = resolveChannelFallbackChain("whatsapp", { availableChannels: ["email"] });
  assert("fallback: restrito a disponíveis", restricted.chain.join(",") === "email");

  const next = resolveNextFallbackChannel("whatsapp", { attemptedChannels: ["email"] });
  assert("fallback: próximo após email = in_app", next === "in_app");

  const semConfig = resolveChannelFallbackChain("email");
  assert("fallback: sem env = vazio/desabilitado", semConfig.chain.length === 0 && semConfig.enabled === false);
}

// ----------------------------------------------------------------------------
// 5. Constantes de status
// ----------------------------------------------------------------------------
{
  assert("status: novos valores existem", ST.PROCESSING === "PROCESSING" && ST.DEDUPED === "DEDUPED" && ST.RETRY_SCHEDULED === "RETRY_SCHEDULED");
  assert("status: legados preservados", ST.PENDING === "PENDING" && ST.SENT === "SENT" && ST.SKIPPED === "SKIPPED");
  assert("status: SENT é terminal", isTerminalDispatchStatus("SENT") === true);
  assert("status: QUEUED não é terminal", isTerminalDispatchStatus("QUEUED") === false);
  assert("status: RETRY_SCHEDULED válido", isValidDispatchStatus("retry_scheduled") === true);
  assert("status: inválido rejeitado", isValidDispatchStatus("ZZZ") === false);
}

// ----------------------------------------------------------------------------
// 6. summarizeEventChannelStatus (Supabase fake)
// ----------------------------------------------------------------------------
{
  const fakeRows = [
    { channel: "in_app", status: "SENT" },
    { channel: "email", status: "SENT" },
    { channel: "whatsapp", status: "FAILED" },
  ];
  const supa = {
    from(table) {
      if (table !== "s7_notification_dispatches") throw new Error(`tabela inesperada: ${table}`);
      return {
        select() {
          return {
            async eq() {
              return { data: fakeRows, error: null };
            },
          };
        },
      };
    },
  };

  const out = await summarizeEventChannelStatus(supa, "evt-123");
  assert("summary DB: ok", out.ok === true && out.event_id === "evt-123");
  assert("summary DB: total 3", out.total === 3);
  assert("summary DB: final partial (SENT+FAILED)", out.final_result === S7_DISPATCH_FINAL_RESULT.PARTIAL);

  const noId = await summarizeEventChannelStatus(supa, "");
  assert("summary DB: sem id falha", noId.ok === false && noId.error === "MISSING_EVENT_ID");
}

// ----------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  console.error(`\n${passed} passaram, ${failures.length} falharam.`);
  process.exit(1);
}
console.log(`✅ S5.2 Dispatcher Central — ${passed} asserts OK.`);
