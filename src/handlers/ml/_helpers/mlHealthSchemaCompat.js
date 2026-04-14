// ======================================================
// Compatibilidade schema marketplace_listing_health (Supabase)
// Quando migrations de payout/subsídio ou shipping v2 não foram aplicadas,
// PostgREST falha com "column ... does not exist". Este módulo detecta e faz
// fallback em selects/upserts sem essas colunas.
// ======================================================

/** @param {unknown} err */
export function isPostgrestMissingColumnError(err) {
  if (!err || typeof err !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (err);
  const code = o.code != null ? String(o.code) : "";
  const msg = o.message != null ? String(o.message) : "";
  const details = o.details != null ? String(o.details) : "";
  const blob = `${msg} ${details}`.toLowerCase();
  return (
    code === "42703" ||
    /column\b.*\bdoes not exist/i.test(msg) ||
    /Could not find the .* column/i.test(msg) ||
    blob.includes("does not exist")
  );
}

/** @param {unknown} err */
export function formatHealthDbError(err) {
  if (!err || typeof err !== "object") return { message: String(err) };
  const o = /** @type {Record<string, unknown>} */ (err);
  return {
    code: o.code != null ? String(o.code) : undefined,
    message: o.message != null ? String(o.message) : undefined,
    details: o.details != null ? String(o.details) : undefined,
    hint: o.hint != null ? String(o.hint) : undefined,
  };
}

export const HEALTH_FINANCIAL_EXTENDED_KEYS = [
  "marketplace_sale_price_amount",
  "marketplace_payout_amount",
  "marketplace_payout_amount_brl",
  "marketplace_payout_currency",
  "marketplace_payout_source",
  "marketplace_payout_synced_at",
  "marketplace_cost_reduction_amount",
  "marketplace_cost_reduction_amount_brl",
  "marketplace_cost_reduction_source",
  "marketplace_cost_reduction_label",
];

export const HEALTH_SHIPPING_V2_KEYS = [
  "shipping_cost_amount",
  "shipping_cost_currency",
  "shipping_cost_source",
  "shipping_cost_context",
  "shipping_cost_label",
];

/** Frete estimado pré-venda (shipping_options/free) + legado auxiliary — strip no mesmo tier que shipping v2. */
export const HEALTH_ESTIMATED_SELLER_SHIPPING_KEYS = [
  "estimated_seller_shipping_amount",
  "estimated_seller_shipping_source",
  "estimated_seller_shipping_currency",
  "estimated_seller_shipping_synced_at",
  "shipping_cost_auxiliary_brl",
  "shipping_cost_auxiliary_source",
];

export const HEALTH_PRICE_V2_KEYS = ["list_or_original_price_brl", "promotional_price_brl"];

/**
 * @param {Record<string, unknown>} row
 * @param {0 | 1 | 2 | 3} tier 0=full, 1=sem payout/subsídio, 2=sem shipping v2, 3=sem price v2
 * @returns {Record<string, unknown>}
 */
export function stripHealthRowToSchemaTier(row, tier) {
  const out = { ...row };
  if (tier >= 1) {
    for (const k of HEALTH_FINANCIAL_EXTENDED_KEYS) delete out[k];
  }
  if (tier >= 2) {
    for (const k of HEALTH_SHIPPING_V2_KEYS) delete out[k];
    for (const k of HEALTH_ESTIMATED_SELLER_SHIPPING_KEYS) delete out[k];
  }
  if (tier >= 3) {
    for (const k of HEALTH_PRICE_V2_KEYS) delete out[k];
  }
  return out;
}

/** Select mínimo antes do merge (upsert). */
const HEALTH_EXISTING_BASE_SELECT =
  "sale_fee_amount, sale_fee_percent, shipping_cost, net_receivable, promotion_price, raw_json";

/** Select para leitura pós-upsert / merge (mesmo subconjunto do fetch). */
export function buildHealthExistingSelectString(tier) {
  if (tier <= 0) {
    return `${HEALTH_EXISTING_BASE_SELECT}, ${HEALTH_PRICE_V2_KEYS.join(", ")}, ${HEALTH_SHIPPING_V2_KEYS.join(", ")}, ${HEALTH_ESTIMATED_SELLER_SHIPPING_KEYS.join(", ")}, ${HEALTH_FINANCIAL_EXTENDED_KEYS.join(", ")}`;
  }
  if (tier === 1) {
    return `${HEALTH_EXISTING_BASE_SELECT}, ${HEALTH_PRICE_V2_KEYS.join(", ")}, ${HEALTH_SHIPPING_V2_KEYS.join(", ")}, ${HEALTH_ESTIMATED_SELLER_SHIPPING_KEYS.join(", ")}`;
  }
  if (tier === 2) {
    return `${HEALTH_EXISTING_BASE_SELECT}, ${HEALTH_PRICE_V2_KEYS.join(", ")}`;
  }
  return HEALTH_EXISTING_BASE_SELECT;
}

/** Select mínimo (schema legado sem colunas de payout v2 / shipping v2). */
const LISTINGS_HEALTH_HEAD =
  "marketplace, external_listing_id, visits, net_receivable, sale_fee_percent, sale_fee_amount, shipping_cost, promotion_price, list_or_original_price_brl, promotional_price_brl, listing_quality_score, listing_quality_status, experience_status, shipping_logistic_type, raw_json";

/**
 * Select para GET /api/ml/listings (health em lote).
 * @param {0 | 1 | 2 | 3} tier
 */
export function listingsHealthSelectForTier(tier) {
  if (tier <= 0) {
    return `${LISTINGS_HEALTH_HEAD}, ${HEALTH_PRICE_V2_KEYS.join(", ")}, ${HEALTH_SHIPPING_V2_KEYS.join(", ")}, ${HEALTH_ESTIMATED_SELLER_SHIPPING_KEYS.join(", ")}, ${HEALTH_FINANCIAL_EXTENDED_KEYS.join(", ")}`;
  }
  if (tier === 1) {
    return `${LISTINGS_HEALTH_HEAD}, ${HEALTH_PRICE_V2_KEYS.join(", ")}, ${HEALTH_SHIPPING_V2_KEYS.join(", ")}, ${HEALTH_ESTIMATED_SELLER_SHIPPING_KEYS.join(", ")}`;
  }
  if (tier === 2) {
    return `${LISTINGS_HEALTH_HEAD}, ${HEALTH_PRICE_V2_KEYS.join(", ")}`;
  }
  return LISTINGS_HEALTH_HEAD;
}

/**
 * Busca linha existente para merge, com fallback de colunas.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function fetchExistingHealthRowCompat(supabase, userId, marketplace, externalListingId) {
  const ext = String(externalListingId);
  /** @type {unknown | null} */
  let lastErr = null;
  for (let tier = 0; tier <= 3; tier++) {
    const sel = buildHealthExistingSelectString(/** @type {0 | 1 | 2 | 3} */ (tier));
    const { data, error } = await supabase
      .from("marketplace_listing_health")
      .select(sel)
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("external_listing_id", ext)
      .maybeSingle();
    if (!error) {
      return {
        data: data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : null,
        schemaTier: /** @type {0 | 1 | 2 | 3} */ (tier),
      };
    }
    lastErr = error;
    if (!isPostgrestMissingColumnError(error)) {
      console.error("[ml/health] existing_health_select_failed", {
        external_listing_id: ext,
        ...formatHealthDbError(error),
      });
      return { data: null, schemaTier: /** @type {0 | 1 | 2 | 3} */ (tier), error };
    }
    console.warn("[ml/health] existing_health_select_retry_legacy_columns", {
      external_listing_id: ext,
      next_tier: tier + 1,
      ...formatHealthDbError(error),
    });
  }
  console.error("[ml/health] existing_health_select_exhausted", {
    external_listing_id: ext,
    ...formatHealthDbError(lastErr),
  });
  return { data: null, schemaTier: 2, error: lastErr };
}

/**
 * Carrega todas as linhas health do usuário para a grid (com fallback).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function fetchAllListingHealthRowsCompat(supabase, userId) {
  /** @type {unknown | null} */
  let lastErr = null;
  for (let tier = 0; tier <= 3; tier++) {
    const sel = listingsHealthSelectForTier(/** @type {0 | 1 | 2 | 3} */ (tier));
    const { data, error } = await supabase
      .from("marketplace_listing_health")
      .select(sel)
      .eq("user_id", userId);
    if (!error) {
      if (tier > 0) {
        console.warn("[ml/listings] health_loaded_with_schema_fallback", {
          schema_tier: tier,
          note: "Rode as migrations de marketplace_listing_health (shipping v2, estimated_seller_shipping_*, payout/subsídio) para schema completo.",
        });
      }
      return { data: data ?? [], schemaTier: /** @type {0 | 1 | 2 | 3} */ (tier) };
    }
    lastErr = error;
    if (!isPostgrestMissingColumnError(error)) {
      console.error("[ml/listings] health_query_error", formatHealthDbError(error));
      return { data: null, schemaTier: /** @type {0 | 1 | 2 | 3} */ (tier), error };
    }
    console.warn("[ml/listings] health_query_retry_legacy_columns", {
      next_tier: tier + 1,
      ...formatHealthDbError(error),
    });
  }
  return { data: null, schemaTier: 2, error: lastErr };
}
