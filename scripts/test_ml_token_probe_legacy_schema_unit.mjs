#!/usr/bin/env node
/**
 * Token probe — schema legado sem marketplace_account_id em ml_tokens
 */
import { fetchMlTokenProbeForMlSeller } from "../src/services/marketplace/marketplaceAccountConnectionHealth.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const USER = "40e77149-6dde-46e8-b441-9287476493fc";
const MAC = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";
const EXT = "677620487";

/** @type {Record<string, unknown> | null} */
const tokenRow = {
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  refresh_token: "refresh-present",
  ml_user_id: EXT,
};

const supabase = {
  from(table) {
    if (table !== "ml_tokens") return {};
    return {
      select(_cols) {
        const cols = String(_cols);
        return {
          eq(_c1, _v1) {
            return {
              eq(_c2, _v2) {
                return {
                  eq(col, val) {
                    if (col === "marketplace_account_id") {
                      return {
                        maybeSingle: async () => ({
                          data: null,
                          error: {
                            code: "42703",
                            message: 'column ml_tokens.marketplace_account_id does not exist',
                          },
                        }),
                      };
                    }
                    if (col === "ml_user_id" && String(val) === EXT) {
                      const data =
                        cols.includes("marketplace_account_id") && !cols.includes("marketplace_account_id,")
                          ? null
                          : { ...tokenRow };
                      const error =
                        cols.includes("marketplace_account_id") && cols.split(",").map((s) => s.trim()).includes("marketplace_account_id")
                          ? { code: "42703", message: "column ml_tokens.marketplace_account_id does not exist" }
                          : null;
                      return {
                        maybeSingle: async () => ({
                          data: error ? null : data,
                          error,
                        }),
                      };
                    }
                    return { maybeSingle: async () => ({ data: null, error: null }) };
                  },
                };
              },
            };
          },
        };
      },
    };
  },
};

const probe = await fetchMlTokenProbeForMlSeller(supabase, USER, "mercado_livre", EXT, MAC);

assert("legacy schema resolves token via ml_user_id", probe.present === true);
assert("resolved_via ml_user_id", probe.resolved_via === "ml_user_id");
assert("has refresh", probe.has_refresh === true);
assert("not expired skew", probe.expires_at != null);

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const dotenv = await import("dotenv");
  const path = await import("node:path");
  const { createClient } = await import("@supabase/supabase-js");
  const { fileURLToPath } = await import("node:url");
  const root = path.dirname(fileURLToPath(import.meta.url));
  dotenv.default.config({ path: path.join(root, "..", ".env") });
  dotenv.default.config({ path: path.join(root, "..", ".env.local"), override: true });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const live = await fetchMlTokenProbeForMlSeller(sb, USER, "mercado_livre", EXT, MAC);
  assert("runtime DEV probe present after OAuth", live.present === true);
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, test: "ml_token_probe_legacy_schema_unit", cases: 5 }, null, 2));
