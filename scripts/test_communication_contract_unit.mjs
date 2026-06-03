#!/usr/bin/env node
/**
 * S5.1 — Contrato Global de Comunicação — testes de unidade (sem rede/DB real).
 *   node scripts/test_communication_contract_unit.mjs
 *
 * Cobre: builder do envelope, validator, metadata padronizada, normalização de
 * dedupe, versionamento, e o fluxo de publishNotificationEvent (idempotência +
 * dedupe por janela) usando um Supabase fake em memória.
 */

import {
  S7_COMMUNICATION_CONTRACT_VERSION,
  S7_COMMUNICATION_PRIORITY,
  buildCommunicationEventEnvelope,
  validateCommunicationEvent,
  buildStandardCommunicationMetadata,
  mergeCommunicationMetadata,
  normalizeDedupeWindowSeconds,
  resolveDefaultPriority,
} from "../src/domain/notifications/central/contract/index.js";
import { publishNotificationEvent } from "../src/domain/notifications/central/events/publishNotificationEvent.js";

/** @type {string[]} */
const failures = [];
let passed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name);
  }
}

const SELLER = "11111111-1111-1111-1111-111111111111";

// ----------------------------------------------------------------------------
// 1. Builder — envelope canônico
// ----------------------------------------------------------------------------
{
  const env = buildCommunicationEventEnvelope({
    category: "BILLING",
    type: "PAYMENT_FAILED",
    seller_id: SELLER,
    payload: { plan_name: "PRO" },
    source_module: "billing",
    source_event: "asaas.payment.overdue",
    emitted_at: "2026-06-02T19:00:00.000Z",
  });

  assert("builder: contract_version carimbado", env.contract_version === S7_COMMUNICATION_CONTRACT_VERSION);
  assert("builder: severity vem do catálogo (warning)", env.severity === "warning");
  assert("builder: priority derivada de warning = high", env.priority === S7_COMMUNICATION_PRIORITY.HIGH);
  assert("builder: idempotency_key gerada", typeof env.idempotency_key === "string" && env.idempotency_key.startsWith("s7:BILLING:PAYMENT_FAILED:"));
  assert("builder: metadata.origin.source_module", env.metadata?.origin?.source_module === "billing");
  assert("builder: metadata.tenant.seller_id", env.metadata?.tenant?.seller_id === SELLER);
  assert("builder: metadata.contract_version", env.metadata?.contract_version === S7_COMMUNICATION_CONTRACT_VERSION);
  assert("builder: dedupe desligado sem chave", env.dedupe_window_seconds === 0 && env.dedupe_key === null);
}

// ----------------------------------------------------------------------------
// 2. Builder — dedupe + metadata custom + prioridade explícita
// ----------------------------------------------------------------------------
{
  const env = buildCommunicationEventEnvelope({
    category: "SYNC",
    type: "SYNC_FAILED",
    seller_id: SELLER,
    priority: "critical",
    dedupe_key: "sync:ml:acc-1",
    dedupe_window_seconds: 120,
    metadata: { custom: { wave: 3 }, contract_version: 999 },
  });

  assert("builder: priority explícita preservada", env.priority === "critical");
  assert("builder: dedupe_key normalizada", env.dedupe_key === "sync:ml:acc-1");
  assert("builder: dedupe window respeitada", env.dedupe_window_seconds === 120);
  assert("builder: metadata.custom propagada", env.metadata?.custom?.wave === 3);
  assert("builder: custom não sobrescreve contract_version reservado", env.metadata?.contract_version === S7_COMMUNICATION_CONTRACT_VERSION);
}

// ----------------------------------------------------------------------------
// 3. Validator — códigos compatíveis com o legado
// ----------------------------------------------------------------------------
{
  const okEnv = buildCommunicationEventEnvelope({ category: "SYSTEM", type: "SYSTEM_ALERT", seller_id: SELLER });
  assert("validator: envelope válido ok", validateCommunicationEvent(okEnv).ok === true);

  const noSeller = buildCommunicationEventEnvelope({ category: "SYSTEM", type: "SYSTEM_ALERT", seller_id: "" });
  assert("validator: MISSING_SELLER_ID", validateCommunicationEvent(noSeller).primaryError === "MISSING_SELLER_ID");

  const badCat = buildCommunicationEventEnvelope({ category: "NOPE", type: "X", seller_id: SELLER });
  assert("validator: INVALID_CATEGORY", validateCommunicationEvent(badCat).primaryError === "INVALID_CATEGORY");

  const badType = buildCommunicationEventEnvelope({ category: "BILLING", type: "NOT_A_TYPE", seller_id: SELLER });
  assert("validator: INVALID_TYPE", validateCommunicationEvent(badType).primaryError === "INVALID_TYPE");

  const badPriority = { ...okEnv, priority: "URGENTÍSSIMO" };
  assert("validator: INVALID_PRIORITY", validateCommunicationEvent(badPriority).errors.includes("INVALID_PRIORITY"));

  const badVersion = { ...okEnv, contract_version: 42 };
  assert("validator: UNSUPPORTED_CONTRACT_VERSION", validateCommunicationEvent(badVersion).errors.includes("UNSUPPORTED_CONTRACT_VERSION"));
}

// ----------------------------------------------------------------------------
// 4. Helpers de metadata / dedupe / prioridade
// ----------------------------------------------------------------------------
{
  const meta = buildStandardCommunicationMetadata({ sellerId: SELLER, severity: "critical", emittedAt: "x" });
  assert("metadata: priority derivada critical", meta.priority === "critical");
  assert("metadata: emitted_at fixável", meta.emitted_at === "x");

  const merged = mergeCommunicationMetadata({ foo: "bar", contract_version: 7 }, meta);
  assert("metadata merge: chave desconhecida vai p/ custom", merged.custom?.foo === "bar");
  assert("metadata merge: reservada ignorada", merged.contract_version === meta.contract_version);

  assert("dedupe: sem chave = 0", normalizeDedupeWindowSeconds(300, false) === 0);
  assert("dedupe: default quando NaN", normalizeDedupeWindowSeconds(undefined, true) === 300);
  assert("dedupe: teto 24h", normalizeDedupeWindowSeconds(999999, true) === 86400);
  assert("dedupe: <=0 desliga", normalizeDedupeWindowSeconds(0, true) === 0);

  assert("priority: info=normal", resolveDefaultPriority("info") === "normal");
  assert("priority: desconhecida=normal", resolveDefaultPriority("zzz") === "normal");
}

// ----------------------------------------------------------------------------
// 5. Supabase fake (em memória) + publishNotificationEvent
// ----------------------------------------------------------------------------
function makeFakeSupabase() {
  /** @type {Array<Record<string, any>>} */
  const events = [];
  let seq = 0;

  function query() {
    /** @type {Array<(r: any) => boolean>} */
    const filters = [];
    const builder = {
      select() {
        return builder;
      },
      eq(col, val) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      gte(col, val) {
        filters.push((r) => String(r[col]) >= String(val));
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        const row = events.filter((r) => filters.every((f) => f(r))).slice(-1)[0] ?? null;
        return { data: row, error: null };
      },
    };
    return builder;
  }

  return {
    _events: events,
    from(table) {
      if (table !== "s7_notification_events") {
        throw new Error(`fake supabase: tabela inesperada ${table}`);
      }
      return {
        select() {
          return query();
        },
        insert(row) {
          return {
            select() {
              return {
                async single() {
                  seq += 1;
                  const stored = {
                    id: `evt-${seq}`,
                    created_at: new Date().toISOString(),
                    ...row,
                  };
                  events.push(stored);
                  return { data: stored, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

{
  const supa = makeFakeSupabase();

  // 5a. Idempotência: mesma chave não cria 2 eventos e não dispara pipeline.
  const r1 = await publishNotificationEvent(supa, {
    category: "SYSTEM",
    type: "SYSTEM_ALERT",
    seller_id: SELLER,
    idempotency_key: "fixed-key-1",
    skip_dispatch: true,
  });
  const r2 = await publishNotificationEvent(supa, {
    category: "SYSTEM",
    type: "SYSTEM_ALERT",
    seller_id: SELLER,
    idempotency_key: "fixed-key-1",
    skip_dispatch: true,
  });
  assert("publish: 1ª publicação ok", r1.ok === true && r1.idempotent === false);
  assert("publish: 2ª é idempotente", r2.ok === true && r2.idempotent === true);
  assert("publish: idempotência não duplica evento", supa._events.length === 1);

  // 5b. Dedupe por janela: chaves de idempotência DIFERENTES, mesmo dedupe_key na janela.
  // (idempotência protege replay exato; dedupe protege conteúdo equivalente recente)
  const d1 = await publishNotificationEvent(supa, {
    category: "SYNC",
    type: "SYNC_FAILED",
    seller_id: SELLER,
    idempotency_key: "dedupe-test-A",
    dedupe_key: "sync:acc-9",
    dedupe_window_seconds: 300,
    skip_dispatch: true,
  });
  const d2 = await publishNotificationEvent(supa, {
    category: "SYNC",
    type: "SYNC_FAILED",
    seller_id: SELLER,
    idempotency_key: "dedupe-test-B",
    dedupe_key: "sync:acc-9",
    dedupe_window_seconds: 300,
    skip_dispatch: true,
  });
  assert("publish: dedupe 1ª cria evento", d1.ok === true && d1.deduped === false);
  assert("publish: dedupe 2ª é absorvida", d2.ok === true && d2.deduped === true);
  assert("publish: dedupe aponta p/ evento original", d2.event?.id === d1.event?.id);
  assert("publish: dedupe não duplica evento", supa._events.length === 2);

  // 5c. Evento inválido não persiste.
  const inv = await publishNotificationEvent(supa, { category: "NOPE", type: "X", seller_id: SELLER });
  assert("publish: inválido bloqueado", inv.ok === false && inv.error === "INVALID_CATEGORY");
  assert("publish: inválido não persiste", supa._events.length === 2);
}

// ----------------------------------------------------------------------------
// Resultado
// ----------------------------------------------------------------------------
if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`);
  for (const f of failures) console.error("  -", f);
  console.error(`\n${passed} passaram, ${failures.length} falharam.`);
  process.exit(1);
}
console.log(`✅ S5.1 Contrato Global de Comunicação — ${passed} asserts OK.`);
