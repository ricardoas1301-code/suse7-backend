#!/usr/bin/env node
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";
import {
  avatarLojaPresente,
  enderecoEmpresaMinimoCompleto,
} from "../src/domain/seller/enderecoEmpresaCompleto.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const companyComplete = {
  cep: "01310100",
  address_street: "Av. Paulista",
  address_number: "1000",
  address_city: "São Paulo",
  address_state: "SP",
  logo_url: "https://cdn.example/logo.png",
};

assert("address complete canonical", enderecoEmpresaMinimoCompleto(companyComplete) === true);
assert(
  "address incomplete without city",
  enderecoEmpresaMinimoCompleto({ ...companyComplete, address_city: "" }) === false,
);
assert("avatar via logo", avatarLojaPresente({ companyLogoUrl: "https://x/a.png" }) === true);
assert("avatar via profile photo", avatarLojaPresente({ profilePhotoUrl: "https://x/p.png" }) === true);
assert("avatar absent", avatarLojaPresente({}) === false);

const baseline = buildOperationalTasksPayload({
  mlInitialSyncPhase: "awaiting_start",
  mlMarketplaceAccountId: "9ee145d1-0000-4000-8000-000000000001",
  universeStable: true,
  profilePhotoUrl: null,
  companyLogoUrl: null,
  primaryCompany: { cep: "", address_street: "", address_number: "" },
});

assert("sync task present", baseline.tasks.some((t) => t.id === "ml_initial_sync_pending"));
assert("avatar task present", baseline.tasks.some((t) => t.id === "store_avatar_pending"));
assert("address task present", baseline.tasks.some((t) => t.id === "store_address_pending"));
assert("phone task removed", !baseline.tasks.some((t) => t.id === "phone_whatsapp_pending"));

const avatarTask = baseline.tasks.find((t) => t.id === "store_avatar_pending");
const addressTask = baseline.tasks.find((t) => t.id === "store_address_pending");
assert("avatar opens company edit", avatarTask?.action?.type === "open_company_edit");
assert("address opens company edit", addressTask?.action?.type === "open_company_edit");
assert("avatar copy homologada", avatarTask?.title === "Cadastrar avatar da loja");
assert("address copy homologada", addressTask?.title === "Cadastrar endereço da loja");
assert("sync copy no SUSE7", baseline.tasks.find((t) => t.id === "ml_initial_sync_pending")?.description?.includes("no SUSE7"));
assert("address copy no SUSE7", addressTask?.description?.includes("no SUSE7"));
assert("avatar copy do SUSE7", avatarTask?.description?.includes("do SUSE7"));
assert("no na SUSE7 in payload", !JSON.stringify(baseline.tasks).includes("na SUSE7"));

const satisfied = buildOperationalTasksPayload({
  universeStable: true,
  profilePhotoUrl: "https://cdn.example/p.png",
  companyLogoUrl: null,
  primaryCompany: companyComplete,
});
assert("avatar hidden when photo present", !satisfied.tasks.some((t) => t.id === "store_avatar_pending"));
assert("address hidden when complete", !satisfied.tasks.some((t) => t.id === "store_address_pending"));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({ pass: true, test: "operational_tasks_post_onboarding_consolidation", cases: 14 }, null, 2),
);
