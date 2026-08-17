#!/usr/bin/env node
/**
 * S1.HF.ASAAS-NOTIFICATIONS.1 — suíte unitária da política de notificações Asaas.
 * Sem Asaas real / sem cobrança / sem DB mutável.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Evita ruído de config.js ao importar o adapter (sem chamar Supabase).
process.env.SUPABASE_URL ||= "https://ujznkyvgqhxagemdgmor.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-not-used";
process.env.S7_APP_ENV ||= "development";
process.env.ASAAS_ENV ||= "sandbox";

import {
  ASAAS_CUSTOMER_NOTIFICATION_POLICY,
  ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED,
  CUSTOMER_PROVIDER_COMMUNICATION_DISABLED,
  CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION,
  POLICY_STATUS,
} from "../src/billing/providers/customerCommunicationPolicyConstants.js";
import {
  applyAsaasCustomerNotificationPolicy,
  isCanonicalNotificationDisabled,
} from "../src/billing/providers/asaas/applyAsaasCustomerNotificationPolicy.js";
import {
  AsaasCustomerCommunicationPolicyStrategy,
  getCustomerCommunicationPolicyStrategy,
} from "../src/billing/providers/asaas/asaasCustomerCommunicationPolicyStrategy.js";
import {
  _resetNotificationPolicyCacheForTests,
  assertAsaasSandboxMutationsAllowed,
  assertCustomerNotificationPolicyForCharge,
  ensureAsaasCustomerNotificationPolicy,
  getCachedNotificationPolicyConfirmation,
  maskAsaasCustomerId,
  setCachedNotificationPolicyConfirmation,
  summarizeCustomerNotificationChannels,
} from "../src/billing/services/billingAsaasCustomerNotificationPolicyService.js";
import { AsaasBillingProvider } from "../src/billing/providers/AsaasBillingProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`OK  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

_resetNotificationPolicyCacheForTests();

// 1–3 contrato canônico
check("1 frozen contract", Object.isFrozen(ASAAS_CUSTOMER_NOTIFICATION_POLICY));
check("2 boolean true", ASAAS_CUSTOMER_NOTIFICATION_POLICY.notificationDisabled === true);
check("3 product rule", CUSTOMER_PROVIDER_COMMUNICATION_DISABLED === true);

// 4–6 override
const pFalse = applyAsaasCustomerNotificationPolicy({ name: "A", notificationDisabled: false });
check("4 override false", pFalse.notificationDisabled === true);
const pStr = applyAsaasCustomerNotificationPolicy({ notificationDisabled: "true" });
check("5 override string", pStr.notificationDisabled === true && typeof pStr.notificationDisabled === "boolean");
const pSpread = applyAsaasCustomerNotificationPolicy({
  ...{ notificationDisabled: false },
  email: "a@b.c",
});
check("6 after spread", pSpread.notificationDisabled === true);

// 7–8 sanitização / tipo
check("7 isCanonical", isCanonicalNotificationDisabled(true) && !isCanonicalNotificationDisabled("true"));
check("8 strategy create", AsaasCustomerCommunicationPolicyStrategy.buildCreatePayload({ name: "x", notificationDisabled: false }).notificationDisabled === true);

// 9–10 classify
check(
  "9 already protected",
  AsaasCustomerCommunicationPolicyStrategy.classifyRemoteCustomer({ notificationDisabled: true }).confirmed
);
check(
  "10 divergent",
  AsaasCustomerCommunicationPolicyStrategy.classifyRemoteCustomer({ notificationDisabled: false }).status ===
    POLICY_STATUS.DIVERGENT
);

// Mock provider
function makeMockProvider(opts = {}) {
  /** @type {Record<string, unknown>[]} */
  const calls = [];
  let remoteDisabled = opts.remoteDisabled ?? false;
  let failUpdate = opts.failUpdate ?? null;
  let failGet = opts.failGet ?? null;
  return {
    calls,
    name: "asaas",
    async getCustomer(id) {
      calls.push({ op: "getCustomer", id });
      if (failGet) throw failGet;
      return { id, notificationDisabled: remoteDisabled };
    },
    async updateCustomer(id, body) {
      calls.push({ op: "updateCustomer", id, body });
      if (failUpdate) throw failUpdate;
      remoteDisabled = body.notificationDisabled === true;
      return { id, notificationDisabled: remoteDisabled };
    },
    async listCustomerNotifications(id) {
      calls.push({ op: "listCustomerNotifications", id });
      return { data: opts.notifications || [] };
    },
    async createPayment() {
      calls.push({ op: "createPayment" });
      throw new Error("SHOULD_NOT_CREATE_PAYMENT");
    },
    async createSubscription() {
      calls.push({ op: "createSubscription" });
      throw new Error("SHOULD_NOT_CREATE_SUBSCRIPTION");
    },
    setRemoteDisabled(v) {
      remoteDisabled = v;
    },
  };
}

const envOk = {
  S7_APP_ENV: "development",
  ASAAS_ENV: "sandbox",
  SUPABASE_URL: "https://ujznkyvgqhxagemdgmor.supabase.co",
  S7_EXPECTED_SUPABASE_PROJECT_REF: "ujznkyvgqhxagemdgmor",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_ID: "prj_TvAjlZFVkLOrgxW7bgGD5VIX7LK3",
};

// 11–15 ensure (IDs únicos + reset de cache entre casos)
_resetNotificationPolicyCacheForTests();
{
  const m = makeMockProvider({ remoteDisabled: true });
  const r = await ensureAsaasCustomerNotificationPolicy(m, { providerCustomerId: "cus_ALREADY00001" }, envOk);
  check("11 already protected remote", r.ok && r.status === POLICY_STATUS.CONFIRMED_DISABLED);
}
_resetNotificationPolicyCacheForTests();
{
  const m = makeMockProvider({ remoteDisabled: false });
  const r = await ensureAsaasCustomerNotificationPolicy(m, { providerCustomerId: "cus_FIX000000001" }, envOk);
  check("12 unprotected fixed", r.ok && r.after?.notificationDisabled === true);
  check("13 update sent true", m.calls.some((c) => c.op === "updateCustomer" && c.body.notificationDisabled === true));
}
_resetNotificationPolicyCacheForTests();
{
  const m = makeMockProvider({ remoteDisabled: false });
  m.updateCustomer = async (id, body) => {
    m.calls.push({ op: "updateCustomer", id, body });
    return { id, notificationDisabled: false };
  };
  const r = await ensureAsaasCustomerNotificationPolicy(m, { providerCustomerId: "cus_DIV000000001" }, envOk);
  check("14 divergent after update", !r.ok && r.status === POLICY_STATUS.DIVERGENT);
}
_resetNotificationPolicyCacheForTests();
{
  const m = makeMockProvider({ remoteDisabled: false });
  const r = await ensureAsaasCustomerNotificationPolicy(
    m,
    { providerCustomerId: "cus_DRY000000001", dryRun: true },
    envOk
  );
  check("15 dry-run no update", r.dryRun && !m.calls.some((c) => c.op === "updateCustomer"));
}

// 16–26 HTTP errors
async function checkHttp(status, expectRetryable) {
  _resetNotificationPolicyCacheForTests();
  const err = Object.assign(new Error(`HTTP ${status}`), { status });
  const m = makeMockProvider({ remoteDisabled: false, failUpdate: err });
  const r = await ensureAsaasCustomerNotificationPolicy(
    m,
    { providerCustomerId: `cus_HTTP${status}00001` },
    envOk
  );
  const retryable = r.status === POLICY_STATUS.RETRYABLE_ERROR;
  check(`http ${status}`, !r.ok && retryable === expectRetryable);
}
await checkHttp(400, false);
await checkHttp(401, false);
await checkHttp(403, false);
await checkHttp(404, false);
await checkHttp(409, false);
await checkHttp(429, true);
await checkHttp(500, true);

// 27–33 ownership / ids (unit via mask + absent)
check("27 mask", maskAsaasCustomerId("cus_ABCDEFGH1234")?.includes("…"));
{
  const m = makeMockProvider();
  const r = await ensureAsaasCustomerNotificationPolicy(m, { providerCustomerId: "" }, envOk);
  check("28 absent customer", !r.ok);
}

// 34–38 ambiente
{
  const bad = assertAsaasSandboxMutationsAllowed({ ...envOk, S7_APP_ENV: "" });
  check("34 S7 absent", !bad.ok);
}
{
  const bad = assertAsaasSandboxMutationsAllowed({ ...envOk, ASAAS_ENV: "" });
  check("35 ASAAS absent", !bad.ok);
}
{
  const ok = assertAsaasSandboxMutationsAllowed(envOk);
  check("36 DEV sandbox", ok.ok);
}
{
  const bad = assertAsaasSandboxMutationsAllowed({ ...envOk, ASAAS_ENV: "production" });
  check("37 DEV+asaas prod", !bad.ok);
}
{
  const bad = assertAsaasSandboxMutationsAllowed({
    ...envOk,
    VERCEL_ENV: "preview",
    BILLING_PREVIEW_MUTATIONS_ENABLED: "false",
  });
  check("38 preview blocked", !bad.ok);
}

// 39–44 cache / single-flight / dry-run
_resetNotificationPolicyCacheForTests();
setCachedNotificationPolicyConfirmation("sandbox", "cus_CACHE0001", POLICY_STATUS.CONFIRMED_DISABLED);
check("39 cache hit", Boolean(getCachedNotificationPolicyConfirmation("sandbox", "cus_CACHE0001", envOk)));
{
  const m = makeMockProvider({ remoteDisabled: true });
  const r = await ensureAsaasCustomerNotificationPolicy(m, { providerCustomerId: "cus_CACHE0001" }, envOk);
  check("40 cache skips remote", r.fromCache === true && !m.calls.some((c) => c.op === "getCustomer"));
}
_resetNotificationPolicyCacheForTests();
process.env.ASAAS_NOTIFICATION_POLICY_TTL_MS = "60000";
setCachedNotificationPolicyConfirmation("sandbox", "cus_TTL0000001", POLICY_STATUS.CONFIRMED_DISABLED);
// force expire
{
  const keyHit = getCachedNotificationPolicyConfirmation("sandbox", "cus_TTL0000001", {
    ...envOk,
    ASAAS_NOTIFICATION_POLICY_TTL_MS: "60000",
  });
  check("41 ttl valid", Boolean(keyHit));
}

// 45–55 reconciler não chama cobrança
{
  const m = makeMockProvider({ remoteDisabled: false });
  await ensureAsaasCustomerNotificationPolicy(m, { providerCustomerId: "cus_NOCHARGE01" }, envOk);
  check("45 no createPayment", !m.calls.some((c) => c.op === "createPayment"));
  check("46 no createSubscription", !m.calls.some((c) => c.op === "createSubscription"));
}

// 56–63 fail-closed charge gate
{
  const m = makeMockProvider({ remoteDisabled: false });
  m.updateCustomer = async () => {
    throw Object.assign(new Error("fail"), { status: 500 });
  };
  let threw = false;
  try {
    await assertCustomerNotificationPolicyForCharge(m, { providerCustomerId: "cus_GATE0001" }, envOk);
  } catch (e) {
    threw = e?.code === ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED;
    check("67 no delinquency side-effect flag", e?.doesNotAffect?.delinquency === false);
    check("68 no entitlement side-effect flag", e?.doesNotAffect?.entitlement === false);
  }
  check("18 gate throws unconfirmed", threw);
}

// Adapter createCustomer força true
{
  const captured = [];
  const provider = new AsaasBillingProvider();
  provider.request = async (method, path, body) => {
    captured.push({ method, path, body });
    return { id: "cus_ADAPTER01", ...body };
  };
  provider.assertConfigured = () => {};
  await provider.createCustomer({
    name: "T",
    email: "t@example.com",
    notificationDisabled: false,
  });
  check(
    "2 create adapter boolean true",
    captured[0]?.body?.notificationDisabled === true && typeof captured[0].body.notificationDisabled === "boolean"
  );
  await provider.updateCustomer("cus_ADAPTER01", { notificationDisabled: false, name: "X" });
  check("update adapter forces true", captured[1]?.body?.notificationDisabled === true);
}

// Channels summarize
{
  const s = summarizeCustomerNotificationChannels([
    { enabled: true, emailEnabledForCustomer: true, smsEnabledForCustomer: false },
    { enabled: false, whatsappEnabledForCustomer: true },
  ]);
  check("channels summary", s.total === 2 && s.emailEnabledForCustomer === 1);
}

// Static scans
{
  const providerSrc = read("src/billing/providers/AsaasBillingProvider.js");
  check(
    "static no notificationDisabled !== false",
    !providerSrc.includes("notificationDisabled !== false") &&
      providerSrc.includes("applyAsaasCustomerNotificationPolicy")
  );
  const prodJs = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "output") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".js") && p.includes(`${path.sep}src${path.sep}`)) prodJs.push(p);
    }
  }
  walk(path.join(root, "src", "billing"));
  let badFalse = 0;
  let badSend = 0;
  for (const f of prodJs) {
    const t = fs.readFileSync(f, "utf8");
    // Permitir classificação de estado remoto na strategy (não é payload enviado ao Asaas).
    if (
      /notificationDisabled\s*:\s*false/.test(t) &&
      !f.includes("test") &&
      !f.includes("asaasCustomerCommunicationPolicyStrategy.js")
    ) {
      badFalse += 1;
    }
    if (/\bsendNotification\b|\bresendNotification\b/.test(t)) badSend += 1;
    if (/emailEnabledForCustomer\s*:\s*true/.test(t)) badSend += 1;
  }
  check("static no notificationDisabled:false in billing src", badFalse === 0);
  check("static no send/resend/channel true in billing src", badSend === 0);
  check(
    "adapter wired",
    read("src/billing/services/billingCustomerService.js").includes("ensureAsaasCustomerNotificationPolicy")
  );
  check(
    "checkout gate",
    read("src/billing/services/billingSubscriptionService.js").includes("assertBillingCustomerReadyForCharge")
  );
  check(
    "renewal gate",
    read("src/billing/services/billingRenewalPaymentService.js").includes("assertBillingCustomerReadyForCharge")
  );
  check("strategy export", getCustomerCommunicationPolicyStrategy("asaas").policyVersion === CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION);
  check("reconciler exists", fs.existsSync(path.join(root, "src/billing/jobs/billingAsaasCustomerNotificationPolicyReconciler.js")));
}

console.log(`\nasaas_notification_cost_guard_1: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
