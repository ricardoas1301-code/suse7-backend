#!/usr/bin/env node
/**
 * DEV.V2.ML-OAUTH-ONBOARDING-M6-IMPLEMENTATION.01E-C — unit tests (sem OAuth real)
 */
import {
  assertMlDocumentMatchesSellerCompanyCnpj,
  assertMlGlobalAccountNotLinkedElsewhere,
  ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
  marketplaceAccountBindingAtivo,
} from "../src/handlers/ml/_helpers/mlOAuthBindingGuards.js";
import {
  marketplaceAccountStatusAtivo,
  resolverContextoFluxoMlOAuth,
  resolverRedirectOnboardingPosOAuth,
} from "../src/handlers/ml/_helpers/resolverContextoFluxoMlOAuth.js";
import { assertInitialConfigurationCompleteForMlConnect } from "../src/onboarding/domain/assertInitialConfigurationCompleteForMlConnect.js";
import { resolveConfigurationSnapshot } from "../src/onboarding/domain/resolverSnapshotConfiguracaoInicial.js";
import { obterCatalogoTermosUso } from "../src/legal/domain/catalogoDocumentosLegais.js";

const termsCatalog = obterCatalogoTermosUso();

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("CNPJ match preserved", assertMlDocumentMatchesSellerCompanyCnpj("62194333000156", "62194333000156").ok === true);
assert(
  "CNPJ mismatch preserved",
  assertMlDocumentMatchesSellerCompanyCnpj("62194333000199", "62194333000156").ok === false,
);
assert(
  "CNPJ fail-open ml absent",
  assertMlDocumentMatchesSellerCompanyCnpj("", "62194333000156").ok === true,
);

assert("status active when null", marketplaceAccountStatusAtivo(null) === true);
assert("status inactive when removed", marketplaceAccountStatusAtivo("removed") === false);
assert("binding ativo when null", marketplaceAccountBindingAtivo(null) === true);

const globalAllow = await assertMlGlobalAccountNotLinkedElsewhere(
  {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: async () => ({ data: [{ user_id: "u1", seller_company_id: "c1", status: "active" }], error: null }),
          }),
        }),
      }),
    }),
  },
  "ml",
  "ext-1",
  "u1",
  "c1",
);
assert("same ML same company allow", globalAllow.ok === true);

const globalBlockTenant = await assertMlGlobalAccountNotLinkedElsewhere(
  {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: async () => ({
              data: [{ user_id: "u2", seller_company_id: "c9", status: "active" }],
              error: null,
            }),
          }),
        }),
      }),
    }),
  },
  "ml",
  "ext-1",
  "u1",
  "c1",
);
assert("same ML diff tenant block", globalBlockTenant.ok === false);
assert(
  "duplicate copy exact",
  globalBlockTenant.message === ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
);
assert(
  "duplicate copy no PII",
  !globalBlockTenant.message.includes("c9") && !globalBlockTenant.message.includes("u2"),
);

const globalBlockSameTenant = await assertMlGlobalAccountNotLinkedElsewhere(
  {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: async () => ({
              data: [{ user_id: "u1", seller_company_id: "c2", status: "active" }],
              error: null,
            }),
          }),
        }),
      }),
    }),
  },
  "ml",
  "ext-1",
  "u1",
  "c1",
);
assert("same ML diff company same tenant block", globalBlockSameTenant.ok === false);

const flowCtx = await resolverContextoFluxoMlOAuth(
  {
    from(table) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "u1",
                  initial_configuration_completed_at: null,
                  first_marketplace_connected_at: null,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: [],
              error: null,
            }),
          }),
        }),
      };
    },
  },
  "u1",
);
assert("flow server derived onboarding", flowCtx.onboarding_first_connection === true);
assert("flow type first path", flowCtx.flow_type === "first_account");

assert(
  "onboarding redirect from state",
  resolverRedirectOnboardingPosOAuth({ flow_type: "onboarding_first_connection" }, false) === true,
);
assert(
  "post onboarding redirect off",
  resolverRedirectOnboardingPosOAuth({ flow_type: "additional_account" }, true) === false,
);

const incompleteSnap = resolveConfigurationSnapshot({
  profile: {
    id: "u1",
    operational_day_closes_at: "18:00",
    operational_working_days: [0, 1, 2, 3, 4, 5, 6],
    operational_cycle_configured_at: new Date().toISOString(),
    first_marketplace_connected_at: null,
    initial_configuration_completed_at: null,
  },
  companies: [
    {
      id: "c1",
      company_name: "Empresa",
      trade_name: "Empresa",
      document_cnpj: "62194333000156",
      contact_email: "a@b.com",
      whatsapp: "11999999999",
      default_tax_rate: "10",
      operational_cost_rate: "1",
      is_primary: true,
      active: true,
    },
  ],
  legalAcceptance: {
    document_type: "TERMS_OF_USE",
    document_version: termsCatalog.document_version,
    document_hash: termsCatalog.document_hash,
    scrolled_to_end: true,
    accepted_at: new Date().toISOString(),
  },
});
assert("snapshot 5/6 incomplete M6", incompleteSnap.configuration.completed === 5);

const completeViaAccountSnap = resolveConfigurationSnapshot({
  profile: {
    id: "u1",
    operational_day_closes_at: "18:00",
    operational_working_days: [0, 1, 2, 3, 4, 5, 6],
    operational_cycle_configured_at: new Date().toISOString(),
    first_marketplace_connected_at: null,
    initial_configuration_completed_at: null,
  },
  companies: [
    {
      id: "c1",
      company_name: "Empresa",
      trade_name: "Empresa",
      document_cnpj: "62194333000156",
      contact_email: "a@b.com",
      whatsapp: "11999999999",
      default_tax_rate: "10",
      operational_cost_rate: "1",
      is_primary: true,
      active: true,
    },
  ],
  legalAcceptance: {
    document_type: "TERMS_OF_USE",
    document_version: termsCatalog.document_version,
    document_hash: termsCatalog.document_hash,
    scrolled_to_end: true,
    accepted_at: new Date().toISOString(),
  },
  marketplaceAccounts: [
    {
      id: "ma-1",
      marketplace: "mercado_livre",
      status: "active",
      user_id: "u1",
      seller_company_id: "c1",
    },
  ],
});
assert("snapshot 6/6 via active marketplace account", completeViaAccountSnap.configuration.completed === 6);
assert("snapshot 100% via active marketplace account", completeViaAccountSnap.configuration.percent === 100);

const gateIncomplete = await assertInitialConfigurationCompleteForMlConnect(
  {
    from(table) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "u1",
                  operational_day_closes_at: "18:00",
                  operational_working_days: [0, 1, 2, 3, 4, 5, 6],
                  operational_cycle_configured_at: null,
                  first_marketplace_connected_at: null,
                  initial_configuration_completed_at: null,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "seller_companies") {
        return {
          select: () => ({
            eq: async () => ({
              data: [
                {
                  id: "c1",
                  company_name: "Empresa",
                  trade_name: "Empresa",
                  document_cnpj: "62194333000156",
                  contact_email: "a@b.com",
                  whatsapp: "11999999999",
                  default_tax_rate: "10",
                  operational_cost_rate: "1",
                  is_primary: true,
                  active: true,
                },
              ],
              error: null,
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: {
                      document_type: "TERMS_OF_USE",
                      document_version: termsCatalog.document_version,
                      document_hash: termsCatalog.document_hash,
                      scrolled_to_end: true,
                      accepted_at: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
      };
    },
  },
  "u1",
);
assert("M1-M5 gate blocks when M5 missing", gateIncomplete.ok === false);
assert("gate code", gateIncomplete.code === "initial_configuration_incomplete");

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "ml_oauth_onboarding_m6_01e_c",
      cases: 18,
      failures: 0,
    },
    null,
    2,
  ),
);
