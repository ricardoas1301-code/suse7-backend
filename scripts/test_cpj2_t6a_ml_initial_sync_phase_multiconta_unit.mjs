#!/usr/bin/env node
/**
 * CPJ-2 T6A — resolveMlInitialSyncOperationalPhase isolado por marketplace_account_id.
 */
import assert from "node:assert/strict";
import { resolveMlInitialSyncOperationalPhase } from "../src/domain/dashboard/resolveMlInitialSyncOperationalPhase.js";

const USER = "40e77149-6dde-46e8-b441-9287476493fc";
const RP = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";
const GO = "ab85841e-fa8f-4a1-8db1-853560170241";
const NOVA = "05c8ab79-0000-4000-8000-000000000099";

function doneJob(accountId, jobType) {
  return {
    marketplace_account_id: accountId,
    job_type: jobType,
    status: "done",
    metadata: { skipped: false },
  };
}

/**
 * @param {{
 *   accounts: Record<string, unknown>[];
 *   jobs: Record<string, unknown>[];
 *   companies?: Record<string, unknown>[];
 * }} dataset
 */
function makeSupabase(dataset) {
  /** @param {string} table */
  function from(table) {
    /** @type {Record<string, unknown>[]} */
    let source = [];
    if (table === "marketplace_accounts") source = dataset.accounts;
    if (table === "marketplace_account_sync_jobs") source = dataset.jobs;
    if (table === "seller_companies") source = dataset.companies ?? [];

    /** @type {Record<string, unknown>} */
    const filters = {};

    function applyFilters() {
      let out = [...source];
      if (filters.eq_user_id) {
        out = out.filter((r) => String(r.user_id ?? USER) === String(filters.eq_user_id) || !r.user_id);
      }
      if (filters.eq_marketplace) {
        out = out.filter((r) => String(r.marketplace) === String(filters.eq_marketplace));
      }
      if (filters.neq_status) {
        out = out.filter((r) => String(r.status) !== String(filters.neq_status));
      }
      if (filters.eq_status) {
        out = out.filter((r) => String(r.status) === String(filters.eq_status));
      }
      if (filters.in_marketplace_account_id) {
        const set = new Set(filters.in_marketplace_account_id);
        out = out.filter((r) => set.has(String(r.marketplace_account_id)));
      }
      if (filters.in_id) {
        const set = new Set(filters.in_id);
        out = out.filter((r) => set.has(String(r.id)));
      }
      if (filters.in_job_type) {
        const set = new Set(filters.in_job_type);
        out = out.filter((r) => set.has(String(r.job_type)));
      }
      return out;
    }

    function finalize() {
      return Promise.resolve({ data: applyFilters(), error: null });
    }

    const api = {
      select() {
        return api;
      },
      eq(col, val) {
        if (col === "user_id") filters.eq_user_id = val;
        if (col === "marketplace") filters.eq_marketplace = val;
        if (col === "status") filters.eq_status = val;
        return api;
      },
      neq(col, val) {
        if (col === "status") filters.neq_status = val;
        return api;
      },
      in(col, vals) {
        if (col === "marketplace_account_id") filters.in_marketplace_account_id = vals;
        if (col === "id") filters.in_id = vals;
        if (col === "job_type") filters.in_job_type = vals;
        return finalize();
      },
      order() {
        return finalize();
      },
      maybeSingle() {
        const rows = applyFilters();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
    };
    return api;
  }

  return { from };
}

const accounts = [
  {
    id: RP,
    status: "active",
    marketplace: "mercado_livre",
    seller_company_id: "5660a0d1-0000-4000-8000-000000000001",
    ml_nickname: "RP_NICK",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: GO,
    status: "active",
    marketplace: "mercado_livre",
    seller_company_id: "f750f98b-0000-4000-8000-000000000002",
    ml_nickname: "GO_NICK",
    created_at: "2025-02-01T00:00:00Z",
  },
  {
    id: NOVA,
    status: "active",
    marketplace: "mercado_livre",
    seller_company_id: "8f4b900a-0000-4000-8000-000000000003",
    ml_nickname: "NOVA_NICK",
    created_at: "2025-09-01T00:00:00Z",
  },
];

const companies = [
  { id: "5660a0d1-0000-4000-8000-000000000001", trade_name: "SMR - RP", document_cnpj: "111" },
  { id: "f750f98b-0000-4000-8000-000000000002", trade_name: "SMR - GO", document_cnpj: "222" },
  { id: "8f4b900a-0000-4000-8000-000000000003", trade_name: "SMR - Nova", document_cnpj: "333" },
];

const jobs = [
  doneJob(RP, "ml_initial_listings_current"),
  doneJob(RP, "ml_initial_products"),
  doneJob(GO, "ml_initial_listings_current"),
  doneJob(GO, "ml_initial_products"),
];

const sb = makeSupabase({ accounts, jobs, companies });
const phase = await resolveMlInitialSyncOperationalPhase(sb, USER);

assert.equal(phase.accounts.length, 3);
const novaState = phase.accounts.find((a) => a.marketplace_account_id === NOVA);
const rpState = phase.accounts.find((a) => a.marketplace_account_id === RP);
const goState = phase.accounts.find((a) => a.marketplace_account_id === GO);

assert.equal(novaState?.phase, "awaiting_start");
assert.equal(rpState?.phase, "none");
assert.equal(goState?.phase, "none");
assert.equal(phase.phase, "awaiting_start");
assert.equal(phase.marketplace_account_id, NOVA);

console.log(
  JSON.stringify({
    pass: true,
    test: "cpj2_t6a_ml_initial_sync_phase_multiconta_unit",
    nova_phase: novaState?.phase,
    rp_phase: rpState?.phase,
    go_phase: goState?.phase,
  }),
);
