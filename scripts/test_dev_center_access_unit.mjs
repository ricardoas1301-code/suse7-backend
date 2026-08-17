#!/usr/bin/env node
/**
 * S_4.8.3 — Unit tests resolveDevCenterAccess (sem API)
 * node scripts/test_dev_center_access_unit.mjs
 */
process.env.SUSE7_DEV_CENTER_ALLOWED_EMAILS = "ops@suse7.com.br,admin@test.com";

const {
  resolveDevCenterAccess,
  isDevCenterAllowlistEmail,
  DEV_CENTER_AUTH_MESSAGES,
} = await import("../src/handlers/devCenter/devCenterAccess.js");

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("allowlist hit", isDevCenterAllowlistEmail({ email: "ops@suse7.com.br" }) === true);
assert("allowlist miss", isDevCenterAllowlistEmail({ email: "seller@test.com" }) === false);
assert("allowlist empty email", isDevCenterAllowlistEmail({ email: "" }) === false);
assert("forbidden message neutral", !DEV_CENTER_AUTH_MESSAGES.FORBIDDEN.toLowerCase().includes("encontrado"));

const mockAdmin = {
  from() {
    return {
      select() {
        return {
          eq() {
            return {
              async maybeSingle() {
                return { data: { is_admin: true }, error: null };
              },
            };
          },
        };
      },
    };
  },
};

const mockSeller = {
  from() {
    return {
      select() {
        return {
          eq() {
            return {
              async maybeSingle() {
                return { data: { is_admin: false }, error: null };
              },
            };
          },
        };
      },
    };
  },
};

const adminAccess = await resolveDevCenterAccess(mockAdmin, { id: "u1", email: "seller@test.com" });
assert("admin allowed", adminAccess.allowed === true && adminAccess.reason === "admin");

const allowAccess = await resolveDevCenterAccess(mockSeller, { id: "u2", email: "ops@suse7.com.br" });
assert("allowlist allowed", allowAccess.allowed === true && allowAccess.reason === "allowlist");

const denied = await resolveDevCenterAccess(mockSeller, { id: "u3", email: "seller@test.com" });
assert("seller denied", denied.allowed === false && denied.reason === "denied");

const noUser = await resolveDevCenterAccess(mockSeller, null);
assert("null user denied", noUser.allowed === false);

if (failures.length) {
  console.error("[S_4.8.3 access unit] FAIL", failures);
  process.exit(1);
}

console.log("[S_4.8.3 access unit] OK — resolveDevCenterAccess", failures.length, "failures");
