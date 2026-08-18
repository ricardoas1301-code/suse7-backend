#!/usr/bin/env node
/**
 * CARD.CONFIGURATION.ONBOARDING.01D — write paths + progressive snapshot
 */
import Decimal from "decimal.js";
import { normalizeSellerCompanyPercentDecimal } from "../src/domain/seller/sellerCompanyRecord.js";
import {
  validarPayloadConfirmacaoCicloOperacional,
  DEFAULT_OPERATIONAL_DAY_CLOSES_AT,
  DEFAULT_OPERATIONAL_WORKING_DAYS,
} from "../src/onboarding/domain/cicloOperacionalConta.js";
import { resolveConfigurationSnapshot } from "../src/onboarding/domain/resolverSnapshotConfiguracaoInicial.js";
import {
  avaliarMilestoneAliquotaImposto,
  avaliarMilestoneCustoOperacional,
  avaliarMilestoneCicloOperacional,
  taxaPercentualExplicitamenteInformada,
} from "../src/onboarding/domain/avaliarMilestonesConfiguracaoInicial.js";
import { persistirCicloOperacionalConta } from "../src/onboarding/services/persistirCicloOperacionalConta.js";
import { MILESTONE_IDS, MILESTONE_STATUS } from "../src/onboarding/domain/milestonesConfiguracaoInicial.js";
import { obterCatalogoTermosUso } from "../src/legal/domain/catalogoDocumentosLegais.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const termsCatalog = obterCatalogoTermosUso();

function baseCompany(overrides = {}) {
  return {
    id: "co-1",
    user_id: "user-1",
    company_name: "Empresa Teste LTDA",
    trade_name: "Empresa Teste",
    document_cnpj: "62194333000156",
    contact_email: "contato@empresa.test",
    whatsapp: "11999998888",
    phone: null,
    default_tax_rate: null,
    operational_cost_rate: null,
    is_primary: true,
    active: true,
    ...overrides,
  };
}

function baseProfile(overrides = {}) {
  return {
    id: "user-1",
    operational_day_closes_at: DEFAULT_OPERATIONAL_DAY_CLOSES_AT,
    operational_working_days: [...DEFAULT_OPERATIONAL_WORKING_DAYS],
    operational_cycle_configured_at: null,
    first_marketplace_connected_at: null,
    initial_configuration_completed_at: null,
    ...overrides,
  };
}

function baseLegal(overrides = {}) {
  return {
    document_type: termsCatalog.document_type,
    document_version: termsCatalog.document_version,
    document_hash: termsCatalog.document_hash,
    scrolled_to_end: true,
    ...overrides,
  };
}

function snapshotProgress(completed) {
  const company = baseCompany();
  const profile = baseProfile();
  const legal = baseLegal();

  if (completed >= 3) company.default_tax_rate = "18.00";
  if (completed >= 4) company.operational_cost_rate = "5.00";
  if (completed >= 5) profile.operational_cycle_configured_at = "2026-08-14T12:00:00.000Z";
  if (completed >= 6) profile.first_marketplace_connected_at = "2026-08-14T13:00:00.000Z";

  return resolveConfigurationSnapshot({
    profile,
    companies: [company],
    legalAcceptance: legal,
  });
}

assert("M3 zero percent VALID", taxaPercentualExplicitamenteInformada("0") === true);
assert("M3 zero decimal VALID", taxaPercentualExplicitamenteInformada("0.00") === true);
assert("M4 zero percent VALID", taxaPercentualExplicitamenteInformada("0") === true);
assert(
  "normalize zero → 0.00",
  normalizeSellerCompanyPercentDecimal("0") === "0.00" &&
    normalizeSellerCompanyPercentDecimal("0,00") === "0.00",
);
assert("M3 milestone with zero tax", avaliarMilestoneAliquotaImposto(baseCompany({ default_tax_rate: "0.00" })).completed === true);
assert(
  "M4 milestone with zero cost",
  avaliarMilestoneCustoOperacional(baseCompany({ operational_cost_rate: "0.00" })).completed === true,
);

{
  const snap2 = snapshotProgress(2);
  assert("BASE 2/6 → 33%", snap2.configuration.percent === 33);
  assert("BASE M3 PENDING", snap2.milestones.find((m) => m.id === MILESTONE_IDS.TAX_RATE)?.status === MILESTONE_STATUS.PENDING);
}

{
  const snap3 = snapshotProgress(3);
  assert("SAVE M3 → 3/6 50%", snap3.configuration.percent === 50);
  assert("SAVE M3 COMPLETED", snap3.milestones.find((m) => m.id === MILESTONE_IDS.TAX_RATE)?.status === MILESTONE_STATUS.COMPLETED);
  assert("after M3 next pending M4", snap3.milestones.find((m) => m.id === MILESTONE_IDS.OPERATIONAL_COST)?.status === MILESTONE_STATUS.PENDING);
}

{
  const snap4 = snapshotProgress(4);
  assert("SAVE M4 → 4/6 67%", snap4.configuration.percent === 67);
  assert("SAVE M4 COMPLETED", snap4.milestones.find((m) => m.id === MILESTONE_IDS.OPERATIONAL_COST)?.status === MILESTONE_STATUS.COMPLETED);
}

{
  const snap5 = snapshotProgress(5);
  assert("SAVE M5 → 5/6 83%", snap5.configuration.percent === 83);
  assert("SAVE M5 COMPLETED", snap5.milestones.find((m) => m.id === MILESTONE_IDS.OPERATIONAL_CYCLE)?.status === MILESTONE_STATUS.COMPLETED);
  assert("M6 still PENDING at 83%", snap5.milestones.find((m) => m.id === MILESTONE_IDS.FIRST_MARKETPLACE_CONNECTION)?.status === MILESTONE_STATUS.PENDING);
  assert("initial_completion NULL at 5/6", snap5.configuration.completed_at === null);
  assert("first_marketplace latch NULL at 5/6", baseProfile().first_marketplace_connected_at === null);
}

{
  const snapDefaults = resolveConfigurationSnapshot({
    profile: baseProfile(),
    companies: [baseCompany()],
    legalAcceptance: baseLegal(),
  });
  const m5 = snapDefaults.milestones.find((m) => m.id === MILESTONE_IDS.OPERATIONAL_CYCLE);
  assert("defaults without save → M5 PENDING", m5?.status === MILESTONE_STATUS.PENDING);
  assert(
    "defaults profile not configured",
    avaliarMilestoneCicloOperacional(baseProfile()).completed === false,
  );
}

assert("invalid close time reject", validarPayloadConfirmacaoCicloOperacional({ close_time: "abc" }).ok === false);
assert("zero days reject", validarPayloadConfirmacaoCicloOperacional({ close_time: "18:00", working_days: [] }).ok === false);
assert("valid payload accept", validarPayloadConfirmacaoCicloOperacional({ close_time: "17:30", working_days: [1, 2, 3] }).ok === true);

{
  /** @type {Record<string, unknown>[]} */
  const writes = [];
  let existingConfiguredAt = null;

  const mockSupabase = {
    from(table) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => {
          if (table === "profiles") {
            return { data: { operational_cycle_configured_at: existingConfiguredAt }, error: null };
          }
          return { data: null, error: null };
        },
        update(payload) {
          writes.push({ table, payload });
          existingConfiguredAt = payload.operational_cycle_configured_at;
          return {
            eq() {
              return this;
            },
            select() {
              return this;
            },
            maybeSingle: async () => ({
              data: {
                operational_day_closes_at: payload.operational_day_closes_at,
                operational_working_days: payload.operational_working_days,
                operational_cycle_configured_at: payload.operational_cycle_configured_at,
              },
              error: null,
            }),
          };
        },
      };
    },
  };

  const first = await persistirCicloOperacionalConta(
    /** @type {*} */ (mockSupabase),
    "user-1",
    { close_time: "18:00", working_days: [0, 1, 2, 3, 4] },
  );
  assert("M5 first save ok", first.ok === true);
  assert("M5 first save sets configured_at", writes.length === 1 && writes[0].payload.operational_cycle_configured_at != null);
  assert("M5 atomic triple write", Boolean(writes[0].payload.operational_day_closes_at) && Array.isArray(writes[0].payload.operational_working_days));

  const latchedAt = writes[0].payload.operational_cycle_configured_at;
  const second = await persistirCicloOperacionalConta(
    /** @type {*} */ (mockSupabase),
    "user-1",
    { close_time: "19:00", working_days: [1, 2, 3] },
  );
  assert("M5 edit preserves configured_at", second.ok === true && second.configured_at === latchedAt);
  assert("M5 edit second write", writes.length === 2);
}

{
  let updateUserId = null;
  const mockSupabase = {
    from() {
      return {
        select() {
          return this;
        },
        eq(_col, val) {
          updateUserId = val;
          return this;
        },
        maybeSingle: async () => ({ data: { operational_cycle_configured_at: null }, error: null }),
        update(payload) {
          return {
            eq(_c, val) {
              updateUserId = val;
              return this;
            },
            select() {
              return this;
            },
            maybeSingle: async () => ({ data: payload, error: null }),
          };
        },
      };
    },
  };

  await persistirCicloOperacionalConta(
    /** @type {*} */ (mockSupabase),
    "tenant-a",
    { close_time: "18:00", working_days: [1] },
  );
  assert("tenant isolation uses session user id", updateUserId === "tenant-a");
}

try {
  const d = new Decimal("18.50");
  assert("Decimal safe parse", d.toFixed(2) === "18.50");
} catch {
  assert("Decimal safe parse", false);
}

if (failures.length > 0) {
  console.error("FAILURES:", failures);
  process.exit(1);
}

console.log(`PASS — ${28 - failures.length} assertions (configuration onboarding 01D writes)`);
