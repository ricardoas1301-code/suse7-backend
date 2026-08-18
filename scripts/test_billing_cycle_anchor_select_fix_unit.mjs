#!/usr/bin/env node
/**
 * Regression — billing_cycle_anchor must not be selected as physical column.
 * SSOT: metadata.scheduled_renewal.billing_cycle_anchor + billingCycleService fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const {
  readScheduledRenewalFromMetadata,
  processScheduledSubscriptionRenewalActivations,
} = await import("../src/billing/services/billingScheduledRenewalActivationService.js");
const { resolveSubscriptionCivilPeriod } = await import("../src/billing/services/billingCycleService.js");
const { processBillingPeriodExpirations } = await import(
  "../src/billing/services/billingPeriodExpirationService.js"
);

const SERVICE_FILE = path.join(root, "src/billing/services/billingScheduledRenewalActivationService.js");
const serviceSource = fs.readFileSync(SERVICE_FILE, "utf8");

function extractListSelectColumns(source) {
  const m = /async function listSubscriptionsWithPendingScheduledRenewal[\s\S]*?\.select\(\s*\n?\s*"([^"]+)"/.exec(
    source
  );
  return m?.[1] ?? "";
}

function selectListsPhysicalAnchorColumn(selectClause) {
  return selectClause
    .split(",")
    .map((part) => part.trim())
    .includes("billing_cycle_anchor");
}

// A — SELECT guard (source + runtime mock)
{
  const selectCols = extractListSelectColumns(serviceSource);
  check("A1 select clause present", selectCols.length > 0);
  check("A2 select excludes physical billing_cycle_anchor column", !selectListsPhysicalAnchorColumn(selectCols));

  let capturedSelect = "";
  const mockSupabase = {
    from(table) {
      check("A3 queries billing_subscriptions", table === "billing_subscriptions");
      return {
        select(cols) {
          capturedSelect = cols;
          if (selectListsPhysicalAnchorColumn(cols)) {
            return {
              eq() {
                return this;
              },
              not() {
                return this;
              },
              order() {
                return this;
              },
              limit() {
                return Promise.resolve({
                  data: null,
                  error: { code: "42703", message: "column billing_subscriptions.billing_cycle_anchor does not exist" },
                });
              },
            };
          }
          return {
            eq() {
              return this;
            },
            not() {
              return this;
            },
            order() {
              return this;
            },
            limit() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };

  await processScheduledSubscriptionRenewalActivations(/** @type {*} */ (mockSupabase), {
    now: new Date("2026-08-18T15:00:00.000Z"),
  });
  check("A4 runtime select captured", capturedSelect.length > 0);
  check("A5 runtime select excludes physical billing_cycle_anchor", !selectListsPhysicalAnchorColumn(capturedSelect));
}

// B — metadata anchor in scheduled_renewal
{
  const meta = {
    scheduled_renewal: {
      payment_id: "pay_1",
      period_start_iso: "2026-08-01T03:00:00.000Z",
      period_end_iso: "2026-08-31T03:00:00.000Z",
      next_due_date: "2026-09-01",
      period_start: "2026-08-01",
      billing_cycle_anchor: "2026-07-21",
    },
  };
  const scheduled = readScheduledRenewalFromMetadata(meta);
  check("B1 reads metadata anchor", scheduled?.billing_cycle_anchor === "2026-07-21");
}

// C — civil period fallback without metadata anchor
{
  const period = resolveSubscriptionCivilPeriod({
    current_period_start: "2026-07-21T03:00:00.000Z",
    metadata: {},
  });
  check("C1 fallback to current_period_start", period.billing_cycle_anchor === "2026-07-21");
}

// D — period-expirations path does not 42703 on empty active set
{
  const mockSupabase = {
    from(table) {
      if (table === "billing_subscriptions") {
        return {
          select(cols) {
            if (selectListsPhysicalAnchorColumn(cols)) {
              return {
                eq() {
                  return this;
                },
                not() {
                  return this;
                },
                order() {
                  return this;
                },
                limit() {
                  return Promise.resolve({
                    data: null,
                    error: { code: "42703", message: "column billing_subscriptions.billing_cycle_anchor does not exist" },
                  });
                },
                in() {
                  return this;
                },
                lte() {
                  return Promise.resolve({ data: [], error: null });
                },
              };
            }
            const chain = {
              eq() {
                return chain;
              },
              not() {
                return chain;
              },
              order() {
                return chain;
              },
              limit() {
                return Promise.resolve({ data: [], error: null });
              },
              in() {
                return chain;
              },
              lte() {
                return chain;
              },
            };
            return chain;
          },
          update() {
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      };
    },
  };

  const result = await processBillingPeriodExpirations(/** @type {*} */ (mockSupabase), {
    now: new Date("2026-08-18T15:00:00.000Z"),
    limit: 10,
  });
  check("D1 period expirations completes", result && typeof result === "object");
  check("D2 scheduled renewal activations present", result.scheduled_renewal_activations != null);
}

// SSOT guard — no other SQL select of physical column in billing services
{
  const billingDir = path.join(root, "src/billing");
  /** @type {string[]} */
  const offenders = [];
  for (const rel of fs.readdirSync(billingDir, { withFileTypes: true })) {
    if (!rel.isDirectory()) continue;
    const svcDir = path.join(billingDir, rel.name);
    for (const file of fs.readdirSync(svcDir).filter((f) => f.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(svcDir, file), "utf8");
      const selects = [...text.matchAll(/\.select\(\s*\n?\s*"([^"]+)"/g)];
      for (const sm of selects) {
        if (selectListsPhysicalAnchorColumn(sm[1])) offenders.push(`${rel.name}/${file}`);
      }
    }
  }
  check("E1 no billing service selects physical billing_cycle_anchor", offenders.length === 0);
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    pass: true,
    tests: ["A_select_guard", "B_metadata_anchor", "C_civil_fallback", "D_period_expirations_path", "E_ssot_scan"],
  })
);
