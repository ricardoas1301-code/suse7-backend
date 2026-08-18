-- Agregados por anúncio vindos das linhas de pedido importadas (fee + frete rateado na venda).
-- Preenchidos em rebuildListingSalesMetricsForUser; grid prioriza estes valores frente ao snapshot do item (health) quando fizer sentido.

ALTER TABLE public.listing_sales_metrics
  ADD COLUMN IF NOT EXISTS commission_amount_total numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_share_total numeric(18, 6) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.listing_sales_metrics.commission_amount_total IS 'Soma de comissão ML por linha (fee_amount ou, se ausente, bruto − líquido na linha).';
COMMENT ON COLUMN public.listing_sales_metrics.shipping_share_total IS 'Soma de shipping_share_amount nas vendas importadas.';
