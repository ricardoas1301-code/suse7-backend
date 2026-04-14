-- Suse7 — frete estimado (anúncio / shipping_options/free) vs frete real (pós-venda / shipments costs).
-- Idempotente. Rode no Supabase SQL Editor (ou: supabase db push após colocar em supabase/migrations/).
--
-- Pré-requisito: tabelas public.marketplace_listing_health e public.sales_orders existentes.

-- ---------------------------------------------------------------------------
-- 1) ANÚNCIO — estimativa do seller (GET /users/{seller_id}/shipping_options/free)
--    Não é frete real da venda; separado do Raio-X (shipping_cost_* oficial).
-- ---------------------------------------------------------------------------
ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS estimated_seller_shipping_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS estimated_seller_shipping_source text,
  ADD COLUMN IF NOT EXISTS estimated_seller_shipping_currency text DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS estimated_seller_shipping_synced_at timestamptz;

COMMENT ON COLUMN public.marketplace_listing_health.estimated_seller_shipping_amount IS
  'Frete estimado do seller no anúncio (pré-venda), ex.: ML shipping_options/free. Separado de shipping_cost_amount (composição Raio-X).';
COMMENT ON COLUMN public.marketplace_listing_health.estimated_seller_shipping_source IS
  'Ex.: ml_shipping_options_free — origem da estimativa.';
COMMENT ON COLUMN public.marketplace_listing_health.estimated_seller_shipping_currency IS
  'Moeda da estimativa (padrão BRL).';
COMMENT ON COLUMN public.marketplace_listing_health.estimated_seller_shipping_synced_at IS
  'Última sincronização da estimativa a partir da API de envio do seller.';

-- Backfill único: copia simulação já denormalizada (se existir coluna auxiliary).
UPDATE public.marketplace_listing_health h
SET
  estimated_seller_shipping_amount = COALESCE(h.estimated_seller_shipping_amount, h.shipping_cost_auxiliary_brl),
  estimated_seller_shipping_source = COALESCE(h.estimated_seller_shipping_source, h.shipping_cost_auxiliary_source),
  estimated_seller_shipping_currency = COALESCE(h.estimated_seller_shipping_currency, 'BRL')
WHERE h.shipping_cost_auxiliary_brl IS NOT NULL
   OR h.shipping_cost_auxiliary_source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) PEDIDO — frete real do seller (GET /shipments/{shipment_id}/costs → senders[].cost)
--    Um envio por pedido no modelo mínimo; vários envios = evoluir para tabela filha.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS external_shipment_id text,
  ADD COLUMN IF NOT EXISTS actual_seller_shipping_amount numeric(18, 6),
  ADD COLUMN IF NOT EXISTS actual_seller_shipping_source text,
  ADD COLUMN IF NOT EXISTS actual_seller_shipping_currency text DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS actual_seller_shipping_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS actual_shipping_raw_json jsonb;

COMMENT ON COLUMN public.sales_orders.external_shipment_id IS
  'ID do envio no marketplace (ex.: ML shipment_id) para GET /shipments/{id}/costs.';
COMMENT ON COLUMN public.sales_orders.actual_seller_shipping_amount IS
  'Custo real do seller no envio (pós-venda), ex.: senders[].cost no ML.';
COMMENT ON COLUMN public.sales_orders.actual_seller_shipping_source IS
  'Ex.: ml_shipments_costs_senders_cost — origem do valor real.';
COMMENT ON COLUMN public.sales_orders.actual_seller_shipping_currency IS
  'Moeda do custo real.';
COMMENT ON COLUMN public.sales_orders.actual_seller_shipping_synced_at IS
  'Última leitura de custos do envio.';
COMMENT ON COLUMN public.sales_orders.actual_shipping_raw_json IS
  'Payload bruto opcional de /shipments/.../costs para auditoria.';

CREATE INDEX IF NOT EXISTS idx_sales_orders_external_shipment_id
  ON public.sales_orders (external_shipment_id)
  WHERE external_shipment_id IS NOT NULL AND trim(external_shipment_id) <> '';
