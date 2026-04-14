-- =============================================================================
-- Suse7 — Precificação multi-cenário ML (baseline + promoções)
-- Persistência opcional do último snapshot resolvido no backend + metadados da
-- API premium GET /items/:id/shipping_options (CEP de referência).
--
-- Idempotente: pode rodar várias vezes.
-- Rode no Supabase SQL Editor ou como migration (supabase db push / CLI).
--
-- Pré-requisito: public.marketplace_listing_health existente.
-- Observação: o backend ainda pode servir tudo em tempo real; estas colunas são
--             para cache, auditoria e evolução futura (sync noturno, etc.).
-- =============================================================================

ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS ml_pricing_reference_zip text,
  ADD COLUMN IF NOT EXISTS ml_item_shipping_options_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipping_subsidy_amount_brl numeric(14, 2),
  ADD COLUMN IF NOT EXISTS promotion_subsidy_amount_brl numeric(14, 2),
  ADD COLUMN IF NOT EXISTS pricing_scenarios_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS pricing_scenarios_snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS pricing_scenario_meta jsonb;

COMMENT ON COLUMN public.marketplace_listing_health.ml_pricing_reference_zip IS
  'Último CEP de referência usado em simulações premium (ex.: GET /items/:id/shipping_options?zip_code=…). Alinhar com env SUSE7_ML_PRICING_REFERENCE_ZIP.';

COMMENT ON COLUMN public.marketplace_listing_health.ml_item_shipping_options_synced_at IS
  'Quando o backend consultou por último a API premium de shipping_options do item (Mercado Livre).';

COMMENT ON COLUMN public.marketplace_listing_health.shipping_subsidy_amount_brl IS
  'Subsídio de frete bancado pelo ML (último valor conhecido no sync), separado do custo seller.';

COMMENT ON COLUMN public.marketplace_listing_health.promotion_subsidy_amount_brl IS
  'Subsídio promocional ML (último valor conhecido), separado de frete e tarifa.';

COMMENT ON COLUMN public.marketplace_listing_health.pricing_scenarios_snapshot IS
  'Snapshot JSON do último payload de cenários (baseline + scenarios[]): sale_price, fees, shipping, subsidies, sources, flags. Opcional.';

COMMENT ON COLUMN public.marketplace_listing_health.pricing_scenarios_snapshot_at IS
  'Timestamp do último snapshot gravado em pricing_scenarios_snapshot.';

COMMENT ON COLUMN public.marketplace_listing_health.pricing_scenario_meta IS
  'Metadados enxutos: ex. { "shipping_cost_source", "shipping_context", "is_shipping_estimated", "promotion_source", "is_promotion_estimated" } sem duplicar o snapshot inteiro.';

CREATE INDEX IF NOT EXISTS marketplace_listing_health_pricing_snapshot_at_idx
  ON public.marketplace_listing_health (pricing_scenarios_snapshot_at DESC)
  WHERE pricing_scenarios_snapshot_at IS NOT NULL;

-- Opcional: índice GIN para consultas @> / ? em pricing_scenarios_snapshot (descomente se for usar).
-- CREATE INDEX IF NOT EXISTS marketplace_listing_health_pricing_snapshot_gin_idx
--   ON public.marketplace_listing_health USING gin (pricing_scenarios_snapshot);
