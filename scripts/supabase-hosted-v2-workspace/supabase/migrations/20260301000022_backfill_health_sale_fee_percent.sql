-- =====================================================================
-- Backfill: sale_fee_percent a partir de sale_fee_amount + preço base de venda.
-- Base: promotional_price_brl ou promotion_price ou marketplace_listings.price
-- (alinhado ao fallback controlado no sync: promo efetiva senão price).
-- Só atualiza onde % ainda é NULL e há tarifa em R$ > 0.
-- =====================================================================

UPDATE public.marketplace_listing_health h
SET sale_fee_percent = ROUND(
  (
    (h.sale_fee_amount::numeric / NULLIF(
      COALESCE(
        NULLIF(h.promotional_price_brl, 0::numeric),
        NULLIF(h.promotion_price, 0::numeric),
        l.price::numeric
      ),
      0::numeric
    )) * 100
  )::numeric,
  2
)
FROM public.marketplace_listings l
WHERE l.user_id = h.user_id
  AND l.marketplace = h.marketplace
  AND l.external_listing_id = h.external_listing_id
  AND h.sale_fee_percent IS NULL
  AND h.sale_fee_amount IS NOT NULL
  AND h.sale_fee_amount > 0
  AND COALESCE(
    NULLIF(h.promotional_price_brl, 0::numeric),
    NULLIF(h.promotion_price, 0::numeric),
    l.price::numeric
  ) IS NOT NULL
  AND COALESCE(
    NULLIF(h.promotional_price_brl, 0::numeric),
    NULLIF(h.promotion_price, 0::numeric),
    l.price::numeric
  ) > 0;

COMMENT ON COLUMN public.marketplace_listing_health.sale_fee_percent IS
  'Percentual da tarifa de venda: oficial (listing_prices/sale_fee_details), fallback (amount÷preço efetivo), ou backfill.';
