-- =====================================================================
-- Tarifa de venda: invalidar legado com % irreais e backfill seguro.
--
-- 1) Percentuais > 30 costumam vir do cálculo antigo (sem frete/subsídio/taxa fixa)
--    ou denominador errado — não são confiáveis; zera % e amount para forçar re-sync.
-- 2) Backfill só quando (amount ÷ preço efetivo) × 100 <= 30 (evita reintroduzir lixo).
-- =====================================================================

UPDATE public.marketplace_listing_health
SET
  sale_fee_percent = NULL,
  sale_fee_amount = NULL
WHERE sale_fee_percent IS NOT NULL
  AND sale_fee_percent::numeric > 30;

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
  ) > 0
  AND (
    (h.sale_fee_amount::numeric / NULLIF(
      COALESCE(
        NULLIF(h.promotional_price_brl, 0::numeric),
        NULLIF(h.promotion_price, 0::numeric),
        l.price::numeric
      ),
      0::numeric
    )) * 100
  ) <= 30;

COMMENT ON COLUMN public.marketplace_listing_health.sale_fee_percent IS
  'Percentual da tarifa: oficial (listing_prices/sale_fee_details), fallback controlado (amount÷preço, teto 30%), backfill idem. Valores >30 legados foram invalidados.';
