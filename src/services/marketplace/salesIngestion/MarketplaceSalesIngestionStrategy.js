/**
 * Fronteira de ingestão incremental de vendas por marketplace.
 * O núcleo SaaS orquestra; cada marketplace implementa a Strategy.
 *
 * @typedef {object} MarketplaceSalesIngestionStrategy
 * @property {string} marketplace
 * @property {(
 *   supabase: import("@supabase/supabase-js").SupabaseClient,
 *   opts?: { deadlineMs?: number; maxAccounts?: number; pageLimit?: number }
 * ) => Promise<{
 *   attempted: boolean;
 *   skipped: boolean;
 *   skip_reason: string | null;
 *   accounts_attempted: number;
 *   orders_fetched: number;
 *   orders_persisted: number;
 *   errors: string[];
 * }>} runIncrementalPollWave
 */

/**
 * @param {MarketplaceSalesIngestionStrategy | null | undefined} strategy
 */
export function assertMarketplaceSalesIngestionStrategy(strategy) {
  if (!strategy || typeof strategy.marketplace !== "string" || !strategy.marketplace.trim()) {
    throw new Error("MarketplaceSalesIngestionStrategy.marketplace obrigatório");
  }
  if (typeof strategy.runIncrementalPollWave !== "function") {
    throw new Error("MarketplaceSalesIngestionStrategy.runIncrementalPollWave obrigatório");
  }
}
