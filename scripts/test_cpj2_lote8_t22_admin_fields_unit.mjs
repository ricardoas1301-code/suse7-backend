#!/usr/bin/env node
/**
 * CPJ2 Lote 8 T22 — consumo ciclo civil, percentual Decimal, cadastro admin, conexão ML.
 * Uso: node ./scripts/test_cpj2_lote8_t22_admin_fields_unit.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  computeUsagePercentDecimal,
  countSalesInCycleWindows,
  isConnectedMarketplaceAccountStatus,
  isMarketplaceSaleInCivilWindow,
  readExtraSalesBonus,
  resolveEffectiveSalesLimit,
} from "../src/handlers/devCenter/devCenterUsagePresentation.js";
import {
  presentCadastralDocument,
  presentCadastralText,
} from "../src/handlers/devCenter/devCenterCadastralPresentation.js";
import { maskDocumentForApi, maskEmailForApi } from "../src/handlers/devCenter/devCenterSellersService.js";
import { apresentarInstanteAcesso } from "../src/handlers/devCenter/devCenterSellerAccessPresentation.js";
import {
  normalizarUrlAvatarSeller,
  resolverUrlAvatarSellerAdmin,
} from "../src/handlers/devCenter/devCenterSellerAvatarPresentation.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`, error instanceof Error ? error.message : error);
  }
}

test("ciclo civil inclusivo usa date_created_marketplace, não mês calendário UTC", () => {
  assert.equal(isMarketplaceSaleInCivilWindow("2026-08-31T12:00:00.000Z", "2026-08-15", "2026-09-14"), true);
  assert.equal(isMarketplaceSaleInCivilWindow("2026-09-15T00:00:00.000Z", "2026-08-15", "2026-09-14"), false);
  assert.equal(isMarketplaceSaleInCivilWindow("2026-08-15T00:00:00.000Z", "2026-08-15", "2026-09-14"), true);
  assert.equal(isMarketplaceSaleInCivilWindow("2026-09-14T23:59:59.999Z", "2026-08-15", "2026-09-14"), true);
});

test("lista agrega consumo por ciclo do seller, sem misturar order_date", () => {
  const cycleByUser = new Map([
    ["u1", { period_start: "2026-08-15", period_end: "2026-09-14" }],
    ["u2", { period_start: "2026-09-01", period_end: "2026-09-30" }],
  ]);
  const map = countSalesInCycleWindows(
    [
      { user_id: "u1", date_created_marketplace: "2026-08-20T10:00:00.000Z" },
      { user_id: "u1", date_created_marketplace: "2026-09-20T10:00:00.000Z" },
      { user_id: "u2", date_created_marketplace: "2026-09-02T10:00:00.000Z" },
      { user_id: "u2", order_date: "2026-09-02T10:00:00.000Z" },
    ],
    cycleByUser,
  );
  assert.equal(map.get("u1"), 1);
  assert.equal(map.get("u2"), 1);
});

test("percentual Decimal 2 casas: 46/60 e 455/60", () => {
  assert.equal(computeUsagePercentDecimal(46, 60), 76.67);
  assert.equal(computeUsagePercentDecimal(455, 60), 758.33);
  assert.equal(computeUsagePercentDecimal(0, 60), 0);
  assert.equal(computeUsagePercentDecimal(10, null), null);
});

test("limite efetivo soma bônus extra sem alterar a base 60", () => {
  assert.equal(resolveEffectiveSalesLimit(60, 0), 60);
  assert.equal(resolveEffectiveSalesLimit(60, 100), 160);
  assert.equal(readExtraSalesBonus({ metadata: { admin_extra_sales_bonus: 0 } }), 0);
});

test("conta ML conectada não trata status vazio como ativo", () => {
  assert.equal(isConnectedMarketplaceAccountStatus("active"), true);
  assert.equal(isConnectedMarketplaceAccountStatus("connected"), true);
  assert.equal(isConnectedMarketplaceAccountStatus(""), false);
  assert.equal(isConnectedMarketplaceAccountStatus("ok"), false);
});

test("e-mail canônico completo só com unmask=true; demais cadastros seguem mascarados", () => {
  const email = "valdecir.longo@example.com";
  const doc = "12345678901";
  assert.equal(presentCadastralText(email, maskEmailForApi, false), maskEmailForApi(email));
  assert.equal(presentCadastralText(email, maskEmailForApi, true), email);
  assert.doesNotMatch(presentCadastralText(email, maskEmailForApi, true) ?? "", /\*/);
  assert.equal(presentCadastralDocument(doc, maskDocumentForApi, true), doc);
  assert.notEqual(presentCadastralDocument(doc, maskDocumentForApi, false), doc);
});

test("listas admin passam unmaskCadastral só com is_admin === true", () => {
  const routes = fs.readFileSync(new URL("../src/handlers/devCenter/devCenterAdminRoutes.js", import.meta.url), "utf8");
  const sellersBlock = routes.slice(
    routes.indexOf('path === "/api/dev-center/sellers"'),
    routes.indexOf('path === "/api/dev-center/sellers"') + 420,
  );
  const subsBlock = routes.slice(
    routes.indexOf('path === "/api/dev-center/subscriptions"'),
    routes.indexOf('path === "/api/dev-center/subscriptions"') + 420,
  );
  const financeBlock = routes.slice(
    routes.indexOf('path === "/api/dev-center/finance"'),
    routes.indexOf('path === "/api/dev-center/finance"') + 420,
  );
  for (const block of [sellersBlock, subsBlock, financeBlock]) {
    assert.match(block, /unmaskCadastral:\s*context\.access\?\.is_admin === true/);
  }
  assert.match(routes, /buildDevCenterFinanceList\(supabase, traceId\)/);
});

test("avatar admin usa logo da empresa principal e não escolhe loja arbitrária", () => {
  const photo = "https://cdn.example/profile.png";
  const primary = { user_id: "u1", logo_url: "https://cdn.example/primary.png", is_primary: true, active: true };
  const other = { user_id: "u1", logo_url: "https://cdn.example/other.png", is_primary: false, active: true };
  assert.equal(resolverUrlAvatarSellerAdmin(photo, [other, primary]), "https://cdn.example/primary.png");
  assert.equal(resolverUrlAvatarSellerAdmin(null, [primary]), "https://cdn.example/primary.png");
  assert.equal(
    resolverUrlAvatarSellerAdmin(photo, [
      other,
      { user_id: "u1", logo_url: "https://cdn.example/third.png", is_primary: false, active: true },
    ]),
    photo,
  );
  assert.equal(
    resolverUrlAvatarSellerAdmin(photo, [
      { logo_url: "https://a", is_primary: true, active: true },
      { logo_url: "https://b", is_primary: true, active: true },
    ]),
    photo,
  );
  assert.equal(resolverUrlAvatarSellerAdmin(null, []), null);
  assert.equal(normalizarUrlAvatarSeller("//http2.mlstatic.com/x.png"), "https://http2.mlstatic.com/x.png");
});

test("lista sellers conta vendas históricas por user_id, sem recorte 30d na agregação", () => {
  const src = fs.readFileSync(new URL("../src/handlers/devCenter/devCenterSellersService.js", import.meta.url), "utf8");
  const listFn = src.slice(src.indexOf("export async function buildDevCenterSellersList"), src.indexOf("export async function buildDevCenterSellerDetail"));
  assert.match(listFn, /selectAllPagedResult\(supabase, "sales_orders", "user_id, date_created_marketplace"/);
  assert.doesNotMatch(listFn, /notNull:\s*"date_created_marketplace"/);
  assert.match(listFn, /sales_count: salesAvailable \? sales\.total : null/);
  assert.match(listFn, /resolverUrlAvatarSellerAdmin\(p\.photo_url/);
});

test("último acesso usa auth last_sign_in_at, sem fallback de cadastro", () => {
  assert.equal(apresentarInstanteAcesso("2026-09-16T09:07:36.453517Z"), "2026-09-16T09:07:36.453517Z");
  assert.equal(apresentarInstanteAcesso(""), null);
  assert.equal(apresentarInstanteAcesso("não-é-data"), null);
  const src = fs.readFileSync(new URL("../src/handlers/devCenter/devCenterSellersService.js", import.meta.url), "utf8");
  const listFn = src.slice(
    src.indexOf("export async function buildDevCenterSellersList"),
    src.indexOf("export async function buildDevCenterSellerDetail"),
  );
  assert.match(listFn, /carregarUltimoLoginAuthPorUsuario/);
  assert.match(listFn, /last_access_at: lastAccessAt/);
  assert.doesNotMatch(listFn, /last_access_at:\s*p\.last_login/);
  assert.match(listFn, /accessLookup\.failed \? null/);
});

if (failed > 0) {
  console.error(`FAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`PASSED ${passed}/${passed + failed}`);
