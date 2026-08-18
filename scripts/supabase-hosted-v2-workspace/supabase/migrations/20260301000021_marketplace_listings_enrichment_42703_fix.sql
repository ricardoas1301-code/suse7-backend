-- ======================================================================
-- Corretivo: PostgreSQL 42703 (coluna inexistente) em GET /api/ml/listings
--
-- Causa: ambientes com apenas a Fase 1 (CREATE marketplace_listings) e sem
-- a migration 20260327120000_marketplace_listings_phase2_enrichment.sql aplicada.
-- O handler seleciona pictures_count e variations_count (entre outras no persist).
--
-- Esta migration é idempotente (IF NOT EXISTS): segura se a Fase 2 já existir.
-- ======================================================================

ALTER TABLE public.marketplace_listings
  ADD COLUMN IF NOT EXISTS official_store_id text,
  ADD COLUMN IF NOT EXISTS inventory_id text,
  ADD COLUMN IF NOT EXISTS seller_custom_field text,
  ADD COLUMN IF NOT EXISTS warranty_text text,
  ADD COLUMN IF NOT EXISTS accepts_mercadopago boolean,
  ADD COLUMN IF NOT EXISTS tags jsonb,
  ADD COLUMN IF NOT EXISTS pictures_count integer,
  ADD COLUMN IF NOT EXISTS variations_count integer,
  ADD COLUMN IF NOT EXISTS shipping_mode text,
  ADD COLUMN IF NOT EXISTS shipping_free boolean,
  ADD COLUMN IF NOT EXISTS shipping_local_pick_up boolean,
  ADD COLUMN IF NOT EXISTS shipping_logistic_type text;

COMMENT ON COLUMN public.marketplace_listings.official_store_id IS 'ID loja oficial ML (quando aplicável).';
COMMENT ON COLUMN public.marketplace_listings.inventory_id IS 'ID de inventário ML quando exposto pela API.';
COMMENT ON COLUMN public.marketplace_listings.seller_custom_field IS 'Campo livre do vendedor no ML (SKU customizado).';
COMMENT ON COLUMN public.marketplace_listings.warranty_text IS 'Texto de garantia (sale_terms / warranty).';
COMMENT ON COLUMN public.marketplace_listings.accepts_mercadopago IS 'Aceita Mercado Pago no anúncio.';
COMMENT ON COLUMN public.marketplace_listings.tags IS 'Tags do item (JSON array).';
COMMENT ON COLUMN public.marketplace_listings.pictures_count IS 'Total de imagens na última importação.';
COMMENT ON COLUMN public.marketplace_listings.variations_count IS 'Total de variações na última importação.';
COMMENT ON COLUMN public.marketplace_listings.shipping_mode IS 'Espelho de shipping.mode para consultas rápidas.';
COMMENT ON COLUMN public.marketplace_listings.shipping_free IS 'Espelho de shipping.free_shipping.';
COMMENT ON COLUMN public.marketplace_listings.shipping_local_pick_up IS 'Espelho de shipping.local_pick_up.';
COMMENT ON COLUMN public.marketplace_listings.shipping_logistic_type IS 'Espelho de shipping.logistic_type.';
