-- Suse7 — saúde de vínculo produto + custos (marketplace_listing_health)
-- Populado pelo backend após sync de anúncio / vínculo SKU; grid também deriva na montagem da API.

ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS has_product_link boolean,
  ADD COLUMN IF NOT EXISTS has_complete_costs boolean,
  ADD COLUMN IF NOT EXISTS product_health_status text;

COMMENT ON COLUMN public.marketplace_listing_health.has_product_link IS
  'True quando marketplace_listings.product_id aponta para produto interno.';

COMMENT ON COLUMN public.marketplace_listing_health.has_complete_costs IS
  'True quando custos obrigatórios do produto (custo, operação, embalagem) estão preenchidos.';

COMMENT ON COLUMN public.marketplace_listing_health.product_health_status IS
  'MISSING_PRODUCT | INCOMPLETE_PRODUCT | OK — espelho da regra de custos do catálogo para o anúncio.';
