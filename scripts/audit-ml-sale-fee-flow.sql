-- =====================================================================
-- Auditoria: tarifa de venda (ML → health → GET /api/ml/listings → modal)
-- Rode no SQL Editor do Supabase (ou psql) com o user_id desejado.
--
-- Passo 1: substituir :user_uuid pelo UUID do usuário (auth.users / profiles).
-- Passo 2: opcionalmente filtrar external_listing_id IN (...) para 5 anúncios problemáticos.
-- =====================================================================

-- Substitua duas vezes abaixo pelo UUID do usuário (mesmo de marketplace_listings.user_id).

WITH params AS (
  SELECT 'SUBSTITUA_PELO_USER_UUID'::uuid AS user_id
),
h AS (
  SELECT
    h.user_id,
    h.marketplace,
    h.external_listing_id,
    h.sale_fee_amount,
    h.sale_fee_percent,
    h.shipping_cost,
    h.net_receivable,
    h.updated_at,
    h.promotion_price,
    h.list_or_original_price_brl,
    h.promotional_price_brl
  FROM public.marketplace_listing_health h
  CROSS JOIN params p
  WHERE h.user_id = p.user_id
    AND h.marketplace = 'mercado_livre'
),
l AS (
  SELECT
    l.user_id,
    l.marketplace,
    l.external_listing_id,
    l.listing_type_id,
    l.price,
    l.original_price,
    l.api_last_seen_at
  FROM public.marketplace_listings l
  CROSS JOIN params p
  WHERE l.user_id = p.user_id
    AND l.marketplace = 'mercado_livre'
)
SELECT
  l.external_listing_id,
  l.listing_type_id,
  l.price AS listing_price,
  l.original_price,
  h.sale_fee_amount,
  h.sale_fee_percent,
  h.shipping_cost,
  h.net_receivable,
  h.promotion_price,
  h.promotional_price_brl,
  h.list_or_original_price_brl,
  h.updated_at AS health_updated_at,
  l.api_last_seen_at AS listing_api_last_seen_at,
  -- Coerência rápida: amount vs % implícito no preço de tabela (não é regra de negócio ML; só diagnóstico)
  CASE
    WHEN h.sale_fee_amount IS NOT NULL
      AND h.sale_fee_amount > 0
      AND COALESCE(NULLIF(h.promotional_price_brl, 0), NULLIF(h.promotion_price, 0), l.price) > 0
    THEN ROUND(
      (
        h.sale_fee_amount::numeric
        / NULLIF(
          COALESCE(
            NULLIF(h.promotional_price_brl, 0::numeric),
            NULLIF(h.promotion_price, 0::numeric),
            l.price::numeric
          ),
          0::numeric
        )
      ) * 100,
      2
    )
    ELSE NULL
  END AS implied_pct_from_amount_over_effective_price
FROM l
LEFT JOIN h
  ON h.user_id = l.user_id
  AND h.marketplace = l.marketplace
  AND h.external_listing_id = l.external_listing_id
ORDER BY l.api_last_seen_at DESC NULLS LAST
LIMIT 200;

-- Para apenas 5 IDs conhecidos:
-- AND l.external_listing_id IN ('MLB123', 'MLB456', ...)
