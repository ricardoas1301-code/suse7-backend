-- ======================================================================
-- ML listing health: custo auxiliar de frete (auditoria de taxas / shipping).
-- Hotfix idempotente para DEV.
-- ======================================================================

ALTER TABLE IF EXISTS public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS shipping_cost_auxiliary_brl numeric(12,2);

COMMENT ON COLUMN public.marketplace_listing_health.shipping_cost_auxiliary_brl IS
  'Custo auxiliar de frete em BRL para auditoria/diagnóstico (não substitui custo principal).';

