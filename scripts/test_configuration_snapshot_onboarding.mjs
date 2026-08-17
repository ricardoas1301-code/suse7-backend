#!/usr/bin/env node
/**
 * CARD.CONFIGURATION.ONBOARDING.01B — snapshot resolver + contrato M6
 */
import { obterCatalogoTermosUso } from "../src/legal/domain/catalogoDocumentosLegais.js";
import { resolveConfigurationSnapshot } from "../src/onboarding/domain/resolverSnapshotConfiguracaoInicial.js";
import {
  avaliarMilestoneAceiteJuridico,
  avaliarMilestoneDadosEmpresa,
  resolverEmpresaPrincipalOnboarding,
  taxaPercentualExplicitamenteInformada,
} from "../src/onboarding/domain/avaliarMilestonesConfiguracaoInicial.js";
import { projetarPercentualConfiguracao } from "../src/onboarding/domain/escopoConfiguracaoInicial.js";
import {
  MARKETPLACE_ACTION_TYPES,
  MARKETPLACE_PROVIDERS,
  montarAcaoNavegacaoMarketplace,
  MARKETPLACE_PROVIDER_FRONTEND_ROUTES,
} from "../src/onboarding/domain/contratoNavegacaoMarketplace.js";
import { MILESTONE_IDS, MILESTONE_STATUS } from "../src/onboarding/domain/milestonesConfiguracaoInicial.js";
import { carregarContextoConfiguracaoInicial } from "../src/onboarding/services/carregarContextoConfiguracaoInicial.js";

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
    email: "contato@empresa.test",
    telefone: "1133334444",
    operational_day_closes_at: "18:00:00",
    operational_working_days: [0, 1, 2, 3, 4, 5, 6],
    operational_cycle_configured_at: null,
    first_marketplace_connected_at: null,
    initial_configuration_completed_at: null,
    ...overrides,
  };
}

function baseLegal(overrides = {}) {
  return {
    document_type: "TERMS_OF_USE",
    document_version: termsCatalog.document_version,
    document_hash: termsCatalog.document_hash,
    scrolled_to_end: true,
    accepted_at: new Date().toISOString(),
    ...overrides,
  };
}

function snapshotWithCompletedCount(n) {
  const company = baseCompany();
  const profile = baseProfile();
  const legal = baseLegal();

  if (n >= 3) company.default_tax_rate = "18.00";
  if (n >= 4) company.operational_cost_rate = "5.00";
  if (n >= 5) profile.operational_cycle_configured_at = "2026-08-14T12:00:00.000Z";
  if (n >= 6) profile.first_marketplace_connected_at = "2026-08-14T13:00:00.000Z";

  const ctx = {
    profile,
    companies: n >= 1 ? [company] : [],
    legalAcceptance: n >= 2 ? legal : null,
  };

  if (n < 1) ctx.companies = [];
  if (n < 2) ctx.legalAcceptance = null;

  return resolveConfigurationSnapshot(ctx);
}

for (const [n, expected] of [
  [0, 0],
  [1, 17],
  [2, 33],
  [3, 50],
  [4, 67],
  [5, 83],
  [6, 100],
]) {
  const snap = snapshotWithCompletedCount(n);
  assert(`${n}/6 → ${expected}%`, snap.configuration.percent === expected);
  assert(`${n}/6 completed count`, snap.configuration.completed === n);
}

{
  const snap = resolveConfigurationSnapshot({
    profile: baseProfile(),
    companies: [baseCompany({ default_tax_rate: "10.00", operational_cost_rate: "2.00" })],
    legalAcceptance: baseLegal(),
  });
  const m5 = snap.milestones.find((m) => m.id === MILESTONE_IDS.OPERATIONAL_CYCLE);
  assert("M5 defaults without configured_at → PENDING", m5?.status === MILESTONE_STATUS.PENDING);
}

{
  const snap = resolveConfigurationSnapshot({
    profile: baseProfile({ operational_cycle_configured_at: "2026-08-14T10:00:00.000Z" }),
    companies: [baseCompany()],
    legalAcceptance: baseLegal(),
  });
  const m5 = snap.milestones.find((m) => m.id === MILESTONE_IDS.OPERATIONAL_CYCLE);
  assert("M5 configured_at → COMPLETED", m5?.status === MILESTONE_STATUS.COMPLETED);
}

{
  const snap = resolveConfigurationSnapshot({ profile: baseProfile(), companies: [], legalAcceptance: null });
  assert("no company → M1 PENDING", snap.milestones[0].status === MILESTONE_STATUS.PENDING);
}

{
  const snap = resolveConfigurationSnapshot({
    profile: baseProfile(),
    companies: [baseCompany()],
    legalAcceptance: baseLegal({ document_version: "2025-01-01-old" }),
  });
  const m2 = snap.milestones.find((m) => m.id === MILESTONE_IDS.LEGAL_ACCEPTANCE);
  assert("stale legal → M2 PENDING", m2?.status === MILESTONE_STATUS.PENDING);
}

assert("valid legal acceptance", avaliarMilestoneAceiteJuridico(baseLegal()).completed === true);

{
  const action = montarAcaoNavegacaoMarketplace(MARKETPLACE_PROVIDERS.MERCADO_LIVRE);
  assert("M6 action type NAVIGATION", action?.type === MARKETPLACE_ACTION_TYPES.NAVIGATION);
  assert("M6 provider MERCADO_LIVRE", action?.provider === MARKETPLACE_PROVIDERS.MERCADO_LIVRE);
  assert(
    "ML route documented for frontend",
    MARKETPLACE_PROVIDER_FRONTEND_ROUTES.MERCADO_LIVRE === "/perfil/integracoes/mercado-livre",
  );
  const snap = resolveConfigurationSnapshot({
    profile: baseProfile(),
    companies: [baseCompany()],
    legalAcceptance: baseLegal(),
  });
  const m6 = snap.milestones.find((m) => m.id === MILESTONE_IDS.FIRST_MARKETPLACE_CONNECTION);
  assert("M6 without latch → PENDING", m6?.status === MILESTONE_STATUS.PENDING);
  assert("M6 has navigation action", m6?.action?.type === MARKETPLACE_ACTION_TYPES.NAVIGATION);
}

{
  const snap = resolveConfigurationSnapshot({
    profile: baseProfile({
      first_marketplace_connected_at: "2026-08-14T15:00:00.000Z",
      initial_configuration_completed_at: "2026-08-14T16:00:00.000Z",
    }),
    companies: [baseCompany({ default_tax_rate: "18", operational_cost_rate: "5" })],
    legalAcceptance: baseLegal(),
  });
  assert("latched config stays 100%", snap.configuration.percent === 100);
  assert("latched config COMPLETED status", snap.configuration.status === "COMPLETED");
  const m6 = snap.milestones.find((m) => m.id === MILESTONE_IDS.FIRST_MARKETPLACE_CONNECTION);
  assert("M6 latched → COMPLETED", m6?.status === MILESTONE_STATUS.COMPLETED);
}

assert("tax 0 explicit valid", taxaPercentualExplicitamenteInformada("0") === true);
assert("tax null invalid", taxaPercentualExplicitamenteInformada(null) === false);

{
  const mine = baseCompany({ user_id: "user-1" });
  const resolved = resolverEmpresaPrincipalOnboarding([mine]);
  assert("primary resolved for own company", resolved.company?.id === mine.id);
}

{
  const resolved = resolverEmpresaPrincipalOnboarding([
    baseCompany({ id: "a", is_primary: true }),
    baseCompany({ id: "b", is_primary: true }),
  ]);
  assert("multiple primary → ambiguous", resolved.ambiguous === true);
}

{
  const writes = [];
  const mockSupabase = {
    from(table) {
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
        maybeSingle: async () => {
          if (table === "profiles") return { data: baseProfile(), error: null };
          if (table === "legal_document_acceptances") return { data: baseLegal(), error: null };
          return { data: null, error: null };
        },
        update(payload) {
          writes.push({ table, payload });
          return {
            eq() {
              return this;
            },
            is() {
              return this;
            },
            select() {
              return this;
            },
            maybeSingle: async () => ({ data: null, error: null }),
          };
        },
      };
      if (table === "seller_companies") {
        return {
          ...api,
          then(resolve) {
            resolve({ data: [baseCompany()], error: null });
          },
        };
      }
      return api;
    },
  };

  await carregarContextoConfiguracaoInicial(/** @type {*} */ (mockSupabase), "user-1");
  assert("GET context load zero writes", writes.length === 0);
}

{
  const snapIncomplete = resolveConfigurationSnapshot({
    profile: baseProfile(),
    companies: [],
    legalAcceptance: null,
  });
  assert("M1→M6 dependency required", snapIncomplete.dependencies.m1_to_m6.required === true);
  assert("M1→M6 m1 not complete when no company", snapIncomplete.dependencies.m1_to_m6.m1_completed === false);
}

{
  const snap = snapshotWithCompletedCount(2);
  assert("no onboarding_progress persisted field", !("onboarding_progress" in snap.configuration));
}

assert("M1 completes without company.phone", avaliarMilestoneDadosEmpresa(baseCompany({ phone: null })).completed === true);
assert("projetar 2/6", projetarPercentualConfiguracao(2) === 33);

{
  const snap = snapshotWithCompletedCount(6);
  assert("6/6 without latch → 100%", snap.configuration.percent === 100);
  assert("6/6 without latch → COMPLETED", snap.configuration.status === "COMPLETED");
  assert("6/6 without latch → completed_at null", snap.configuration.completed_at === null);
  assert("6/6 without latch → completed=6", snap.configuration.completed === 6);
}

if (failures.length) {
  console.error("FAIL", failures);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "configuration_snapshot_onboarding_01b",
      cases: 23,
      failures: 0,
    },
    null,
    2,
  ),
);
