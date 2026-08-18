import { ML_MARKETPLACE_SLUG } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import { runIncrementalMlSalesPollWave } from "../mlIncrementalSalesPoll.js";
import { assertMarketplaceSalesIngestionStrategy } from "./MarketplaceSalesIngestionStrategy.js";

/**
 * Strategy ML — polling incremental oficial de vendas (watermark + overlap).
 * Regras específicas do Mercado Livre ficam aqui / em mlIncrementalSalesPoll.
 *
 * @type {import("./MarketplaceSalesIngestionStrategy.js").MarketplaceSalesIngestionStrategy}
 */
export const MercadoLivreSalesIngestionStrategy = {
  marketplace: ML_MARKETPLACE_SLUG,
  runIncrementalPollWave: runIncrementalMlSalesPollWave,
};

assertMarketplaceSalesIngestionStrategy(MercadoLivreSalesIngestionStrategy);
