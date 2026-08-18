-- Preços exibidos/persistidos para precificação: valor de tabela (produto) e preço promocional efetivo.
ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS list_or_original_price_brl numeric(18, 6),
  ADD COLUMN IF NOT EXISTS promotional_price_brl numeric(18, 6);

COMMENT ON COLUMN public.marketplace_listing_health.list_or_original_price_brl IS 'Valor do produto (list/original): API ML original_price com fallback em price; consolidado no sync.';
COMMENT ON COLUMN public.marketplace_listing_health.promotional_price_brl IS 'Preço efetivo em promoção quando houver: prioridade sale_price.amount; senão extrato do item.';

UPDATE public.marketplace_listing_health
SET promotional_price_brl = promotion_price
WHERE promotional_price_brl IS NULL
  AND promotion_price IS NOT NULL;
