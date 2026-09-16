#!/usr/bin/env node
/**
 * CPS 1 / T4 — comparação por instante do ciclo interno.
 * Exercita resolveSellerBillingCycle (função real) com persistência simulada.
 * Sem PostgreSQL remoto, sem cobrança, sem alteração de datas no DEV.
 */
import { resolveSellerBillingCycle } from "../src/billing/services/billingCycleService.js";

/** @type {string[]} */
const falhas = [];
function verificar(nome, condicao) {
  if (!condicao) falhas.push(nome);
}

/**
 * Query builder encadeável o bastante para listar assinaturas, listar ciclos de renovação e persistir.
 * @param {{ rows?: Record<string, unknown>[]; updates?: Array<{ id: string; payload: Record<string, unknown> }> }} estado
 */
function criarSupabaseSimulado(estado) {
  const rows = estado.rows ?? [];
  const updates = estado.updates ?? [];

  function cadeia(resultado) {
    const thenable = {
      select() {
        return cadeia(resultado);
      },
      eq() {
        return cadeia(resultado);
      },
      in() {
        return cadeia(resultado);
      },
      order() {
        return cadeia(resultado);
      },
      limit() {
        return cadeia(resultado);
      },
      maybeSingle() {
        return cadeia({ data: null, error: null });
      },
      single() {
        return cadeia({ data: null, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve(resultado).then(resolve, reject);
      },
    };
    return thenable;
  }

  return {
    from(tabela) {
      if (tabela === "billing_subscriptions") {
        return {
          select() {
            return cadeia({ data: rows, error: null });
          },
          update(payload) {
            return {
              eq(_coluna, id) {
                updates.push({ id: String(id), payload: { ...payload } });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      return {
        select() {
          return cadeia({ data: [], error: null });
        },
        update() {
          return {
            eq() {
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
}

const agora = new Date("2026-09-16T14:00:00.000Z");
const babyInterno = {
  id: "0da0ccc5-e329-417d-bb0b-63f4a896b4eb",
  user_id: "seller-t4",
  plan_id: "baby-plan",
  plan_key: "baby",
  provider: "internal",
  status: "internal_free",
  current_period_start: "2026-09-14T00:00:00+00:00",
  current_period_end: "2026-10-13T23:59:59.999+00:00",
  next_due_date: "2026-10-14",
  created_at: "2026-09-14T00:00:00+00:00",
  updated_at: "2026-09-16T14:25:26.000Z",
};

{
  const estado = { rows: [babyInterno], updates: [] };
  await resolveSellerBillingCycle(criarSupabaseSimulado(estado), "seller-t4", agora);
  verificar("1. mesmo instante +00:00/.000Z não grava", estado.updates.length === 0);
}

{
  const estado = { rows: [babyInterno], updates: [] };
  const supabase = criarSupabaseSimulado(estado);
  await resolveSellerBillingCycle(supabase, "seller-t4", agora);
  await resolveSellerBillingCycle(supabase, "seller-t4", agora);
  verificar("2. chamadas repetidas com ciclo inalterado não gravam", estado.updates.length === 0);
}

{
  const estado = {
    rows: [{ ...babyInterno, current_period_start: "2026-09-14T12:00:00.000Z" }],
    updates: [],
  };
  await resolveSellerBillingCycle(criarSupabaseSimulado(estado), "seller-t4", agora);
  verificar("3. início realmente diferente persiste", estado.updates.length === 1);
  verificar(
    "3. persistência grava o início normalizado do ciclo",
    estado.updates[0]?.payload?.current_period_start === "2026-09-14T00:00:00.000Z"
  );
}

{
  const estado = {
    rows: [
      {
        ...babyInterno,
        next_billing_at: "2026-11-14T00:00:00.000Z",
        next_due_date: "2026-10-14",
      },
    ],
    updates: [],
  };
  await resolveSellerBillingCycle(criarSupabaseSimulado(estado), "seller-t4", agora);
  verificar("4. next_due_date realmente diferente persiste", estado.updates.length === 1);
  verificar(
    "4. persistência preserva next_due_date como data civil",
    estado.updates[0]?.payload?.next_due_date === "2026-11-14" &&
      !String(estado.updates[0]?.payload?.next_due_date ?? "").includes("T")
  );
}

{
  const ausente = { rows: [{ ...babyInterno, current_period_start: null }], updates: [] };
  await resolveSellerBillingCycle(criarSupabaseSimulado(ausente), "seller-t4", agora);
  verificar("5. data ausente persiste (sem falsa equivalência)", ausente.updates.length === 1);

  const invalida = { rows: [{ ...babyInterno, current_period_end: "não-é-data" }], updates: [] };
  await resolveSellerBillingCycle(criarSupabaseSimulado(invalida), "seller-t4", agora);
  verificar("5. data inválida persiste (sem falsa equivalência)", invalida.updates.length === 1);
}

{
  const estado = {
    rows: [
      {
        ...babyInterno,
        provider: "asaas",
        status: "active",
        current_period_start: "2026-09-14T00:00:00+00:00",
        current_period_end: "2026-10-13T23:59:59.999+00:00",
      },
    ],
    updates: [],
  };
  await resolveSellerBillingCycle(criarSupabaseSimulado(estado), "seller-t4", agora);
  verificar("6. provider não interno não persiste ciclo interno", estado.updates.length === 0);
}

if (falhas.length) {
  console.error("[CPS1.T4 unit] FAIL");
  for (const falha of falhas) console.error(" -", falha);
  process.exit(1);
}

console.log("[OK] test_cps1_t4_ciclo_instante_unit.mjs (função real + persistência simulada; PostgreSQL não executado)");
