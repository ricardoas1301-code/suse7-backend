/**
 * Simulação leve do fluxo de probe de token (multi-conta).
 * Uso: node scripts/mlTokenProbeAlignment.simulation.mjs
 * Não acessa rede nem Supabase real — só valida o stub encadeado.
 */
import assert from "node:assert/strict";
import { fetchMlTokenProbeForMlSeller } from "../src/services/marketplace/marketplaceAccountConnectionHealth.js";

function chainResult(final) {
  const api = {
    select() {
      return api;
    },
    eq() {
      return api;
    },
    order() {
      return api;
    },
    limit() {
      return api;
    },
    maybeSingle: async () => final,
  };
  return api;
}

function makeSupabase(macBranch, mlUserBranch) {
  let fromCalls = 0;
  return {
    from(table) {
      if (table !== "ml_tokens") throw new Error(`unexpected table ${table}`);
      fromCalls += 1;
      if (fromCalls === 1) return chainResult(macBranch);
      return chainResult(mlUserBranch);
    },
  };
}

async function run() {
  const uid = "00000000-0000-4000-8000-000000000001";
  const mac = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
  const ext = "2649629037";

  // 1) Token encontrado por marketplace_account_id, ml_user_id alinhado
  const s1 = makeSupabase(
    {
      data: {
        expires_at: "2099-01-01T00:00:00.000Z",
        refresh_token: "r1",
        ml_user_id: ext,
        marketplace_account_id: mac,
      },
      error: null,
    },
    { data: null, error: null }
  );
  const p1 = await fetchMlTokenProbeForMlSeller(s1, uid, "mercado_livre", ext, mac);
  assert.equal(p1.present, true);
  assert.equal(p1.token_account_mismatch, false);
  assert.equal(p1.resolved_via, "marketplace_account_id");

  // 2) Por MAC: ml_user_id divergente → mismatch
  const s2 = makeSupabase(
    {
      data: {
        expires_at: "2099-01-01T00:00:00.000Z",
        refresh_token: "r1",
        ml_user_id: "9999999999",
        marketplace_account_id: mac,
      },
      error: null,
    },
    { data: null, error: null }
  );
  const p2 = await fetchMlTokenProbeForMlSeller(s2, uid, "mercado_livre", ext, mac);
  assert.equal(p2.present, false);
  assert.equal(p2.token_account_mismatch, true);

  // 3) Sem linha por MAC; resolve por ml_user_id com marketplace_account_id alinhado
  const s3 = makeSupabase(
    { data: null, error: null },
    {
      data: {
        expires_at: "2099-01-01T00:00:00.000Z",
        refresh_token: "r1",
        ml_user_id: ext,
        marketplace_account_id: mac,
      },
      error: null,
    }
  );
  const p3 = await fetchMlTokenProbeForMlSeller(s3, uid, "mercado_livre", ext, mac);
  assert.equal(p3.present, true);
  assert.equal(p3.token_account_mismatch, false);
  assert.equal(p3.resolved_via, "ml_user_id");

  // 4) Por ml_user_id: token aponta para outra conta
  const s4 = makeSupabase(
    { data: null, error: null },
    {
      data: {
        expires_at: "2099-01-01T00:00:00.000Z",
        refresh_token: "r1",
        ml_user_id: ext,
        marketplace_account_id: "bbbbbbbb-bbbb-4ccc-dddd-eeeeeeeeeeee",
      },
      error: null,
    }
  );
  const p4 = await fetchMlTokenProbeForMlSeller(s4, uid, "mercado_livre", ext, mac);
  assert.equal(p4.present, false);
  assert.equal(p4.token_account_mismatch, true);

  console.log("mlTokenProbeAlignment.simulation: OK");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
