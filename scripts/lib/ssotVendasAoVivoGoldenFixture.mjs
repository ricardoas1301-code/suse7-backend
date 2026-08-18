/**
 * Loader da fixture golden congelada — Vendas ao Vivo (46 orders auditadas 2026-08-10).
 * Infraestrutura de teste/auditoria apenas.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSaleExecutiveSummary } from "../../src/domain/sales/buildSaleExecutiveSummary.js";
import { resolveExecutiveSummaryPeriod } from "../../src/domain/sales/saleExecutivePeriod.js";

const scriptLibDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = path.join(
  scriptLibDir,
  "..",
  "fixtures",
  "ssot_vendas_ao_vivo_golden_2026_08_10.json",
);

/**
 * @param {string} [fixturePath]
 */
export function loadSsotVendasAoVivoGoldenFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(raw);
  const ids = Array.isArray(fixture.external_order_ids)
    ? fixture.external_order_ids.map(String).filter(Boolean)
    : [];
  if (ids.length !== fixture.expected_orders_count) {
    throw new Error(
      `Fixture ${fixturePath}: expected ${fixture.expected_orders_count} orders, got ${ids.length}`,
    );
  }
  return { ...fixture, external_order_ids: ids, fixture_path: fixturePath };
}

/**
 * Agrega executive summary somente sobre external_order_ids congelados na fixture.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {ReturnType<typeof loadSsotVendasAoVivoGoldenFixture>} fixture
 * @param {{ marketplace?: string }} [opts]
 */
export async function buildFrozenGoldenExecutiveSummary(supabase, fixture, opts = {}) {
  const periodResult = resolveExecutiveSummaryPeriod({
    start_datetime: fixture.start_datetime,
    end_datetime: fixture.end_datetime,
    period_preset: "operational_cycle",
  });
  if (!periodResult.ok) {
    throw new Error(`Período inválido na fixture: ${periodResult.error ?? "unknown"}`);
  }

  return buildSaleExecutiveSummary(supabase, fixture.tenant_user_id, {
    period: periodResult.period,
    marketplace: opts.marketplace ?? "mercado_livre",
    restrict_external_order_ids: fixture.external_order_ids,
  });
}

/**
 * Contagem read-only de orders elegíveis na janela temporal (contexto histórico).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {ReturnType<typeof loadSsotVendasAoVivoGoldenFixture>} fixture
 */
export async function countEligibleOrdersInTemporalWindow(supabase, fixture) {
  const periodResult = resolveExecutiveSummaryPeriod({
    start_datetime: fixture.start_datetime,
    end_datetime: fixture.end_datetime,
    period_preset: "operational_cycle",
  });
  const payload = await buildSaleExecutiveSummary(supabase, fixture.tenant_user_id, {
    period: periodResult.period,
    marketplace: "mercado_livre",
  });
  return Number(payload.summary?.orders_count ?? 0);
}
