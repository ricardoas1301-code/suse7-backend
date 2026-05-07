-- ======================================================================
-- ML listing health: origem do custo auxiliar de frete.
-- Hotfix idempotente para DEV.
-- ======================================================================

ALTER TABLE IF EXISTS public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS shipping_cost_auxiliary_source text;

COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_auxiliary_source IS
  'Origem do shipping_cost_auxiliary_brl (ex.: shipping_options_free, listing_api, fallback).';

