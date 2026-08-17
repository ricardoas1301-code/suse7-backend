#!/usr/bin/env node
/**
 * OAuth reconexão — conta existente reutilizada (sem duplicar marketplace_accounts).
 * Cenário: mesmo user + marketplace + external_seller_id → update, não insert.
 */
import { upsertMercadoLivreMarketplaceAccount } from "../src/handlers/ml/_helpers/mlOAuthConnectPersistence.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const EXISTING_ACCOUNT_ID = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";
const USER_ID = "40e77149-6dde-46e8-b441-9287476493fc";
const SELLER_CO = "5660a0d1-6105-4aaa-9835-6c8d9d54199c";
const EXT_SELLER = "677620487";

/** @type {Record<string, unknown>[]} */
let marketplaceRows = [
  {
    id: EXISTING_ACCOUNT_ID,
    user_id: USER_ID,
    marketplace: "mercado_livre",
    external_seller_id: EXT_SELLER,
    seller_company_id: SELLER_CO,
    status: "active",
  },
];

/** @type {Record<string, unknown>[]} */
let mlTokenRows = [];

function makeSupabaseMock() {
  return {
    from(table) {
      if (table === "marketplace_accounts") {
        return {
          select(_cols) {
            return {
              eq(col, val) {
                const chain = [{ col, val }];
                const builder = {
                  eq(c, v) {
                    chain.push({ col: c, val: v });
                    return builder;
                  },
                  limit(_n) {
                    return {
                      async then(resolve) {
                        let rows = [...marketplaceRows];
                        for (const f of chain) {
                          rows = rows.filter((r) => String(r[f.col]) === String(f.val));
                        }
                        resolve({ data: rows, error: null });
                      },
                    };
                  },
                };
                return builder;
              },
            };
          },
          update(patch) {
            return {
              eq(_col, id) {
                return {
                  async then(resolve) {
                    const idx = marketplaceRows.findIndex((r) => String(r.id) === String(id));
                    if (idx >= 0) {
                      marketplaceRows[idx] = { ...marketplaceRows[idx], ...patch };
                    }
                    resolve({ error: null });
                  },
                };
              },
            };
          },
          insert(_row) {
            return {
              select() {
                return {
                  async then(resolve) {
                    resolve({ data: null, error: { code: "should_not_insert", message: "duplicate" } });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "ml_tokens") {
        return {
          upsert(_payload, _opts) {
            return {
              select() {
                return {
                  async then(resolve) {
                    resolve({
                      data: null,
                      error: { code: "42P10", message: "no unique constraint matching onConflict" },
                    });
                  },
                };
              },
            };
          },
          select(_cols) {
            return {
              eq() {
                const chain = [];
                const builder = {
                  eq(c, v) {
                    chain.push([c, v]);
                    return builder;
                  },
                  maybeSingle() {
                    return Promise.resolve({ data: null, error: null });
                  },
                  order() {
                    return {
                      limit() {
                        return Promise.resolve({ data: mlTokenRows, error: null });
                      },
                    };
                  },
                };
                return builder;
              },
            };
          },
          insert(payload) {
            return {
              select() {
                return Promise.resolve({
                  data: [{ id: "tok-new", ...payload }],
                  error: null,
                });
              },
            };
          },
        };
      }
      return {};
    },
  };
}

const beforeCount = marketplaceRows.length;

const accResult = await upsertMercadoLivreMarketplaceAccount(makeSupabaseMock(), {
  userId: USER_ID,
  marketplace: "mercado_livre",
  externalSellerId: EXT_SELLER,
  sellerCompanyIdCandidate: SELLER_CO,
  preferExplicitSellerCompany: true,
  mlNickname: "SUPERMETAL",
  tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  siteId: "MLB",
  rawMeJson: {},
});

assert("upsert ok", accResult.ok === true);
assert("reutiliza mesma conta", accResult.accountId === EXISTING_ACCOUNT_ID);
assert("nao marca created", accResult.created === false);
assert("count marketplace_accounts inalterado", marketplaceRows.length === beforeCount);
assert(
  "seller_company_id preservado",
  String(marketplaceRows[0]?.seller_company_id) === SELLER_CO,
);
assert("status permanece active", String(marketplaceRows[0]?.status).toLowerCase() === "active");

const persistSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(
    new URL("../src/handlers/ml/_helpers/mlOAuthConnectPersistence.js", import.meta.url),
    "utf8",
  ),
);
assert(
  "42P10 nao aborta persistencia",
  persistSrc.includes("persist_ml_tokens_legacy_unique_fallback") &&
    !persistSrc.includes("ml_tokens_multi_account_unique_required"),
);

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({ pass: true, test: "ml_oauth_reconnect_idempotency_unit", cases: 7 }, null, 2),
);
