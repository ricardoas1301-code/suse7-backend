#!/usr/bin/env node
/**
 * Bootstrap social — perfil mínimo, sem dados comerciais do provedor.
 */
import { bootstrapSocialSessionOnce } from "../src/signup/services/bootstrapSocialSessionService.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

/** @type {Record<string, unknown>[]} */
const profileRows = [];

const socialUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "seller.social@example.com",
  app_metadata: { provider: "google" },
  user_metadata: { full_name: "João da Silva", name: "João da Silva" },
};

const supabase = {
  from(table) {
    if (table !== "profiles") return {};
    return {
      select() {
        return {
          eq(_c, userId) {
            return {
              maybeSingle: async () => ({
                data: profileRows.find((r) => r.id === userId) ?? null,
                error: null,
              }),
            };
          },
        };
      },
      insert(row) {
        profileRows.push(row);
        return Promise.resolve({ error: null });
      },
    };
  },
};

const userId = socialUser.id;

const first = await bootstrapSocialSessionOnce(supabase, socialUser);
assert("first bootstrap ok", first.ok === true);
assert("first bootstrap code", first.code === "BOOTSTRAPPED");
assert("profile created once", profileRows.length === 1);
assert("email preserved", profileRows[0]?.email === "seller.social@example.com");
assert("nome not from google", profileRows[0]?.nome == null);
assert("nome_loja not from google", profileRows[0]?.nome_loja == null);
assert("primeiro_login true", profileRows[0]?.primeiro_login === true);

const second = await bootstrapSocialSessionOnce(supabase, socialUser);
assert("second bootstrap idempotent", second.ok === true && second.idempotent === true);
assert("profile count still 1", profileRows.length === 1);

const emailUser = { ...socialUser, app_metadata: { provider: "email" } };
const rejected = await bootstrapSocialSessionOnce(supabase, emailUser);
assert("email provider rejected", rejected.ok === false && rejected.code === "NOT_SOCIAL_PROVIDER");

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "signup_social_bootstrap_unit",
      cases: 10,
    },
    null,
    2,
  ),
);
