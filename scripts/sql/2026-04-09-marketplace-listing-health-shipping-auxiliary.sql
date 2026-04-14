-- Suse7 — frete simulado (shipping_options/free) separado do frete oficial Raio-X.
-- Opcional: denormalizar para consultas SQL; a aplicação também persiste em raw_json.suse7_shipping_cost.
-- Idempotente.

alter table if exists public.marketplace_listing_health
  add column if not exists shipping_cost_auxiliary_brl numeric(14,2),
  add column if not exists shipping_cost_auxiliary_source text;

comment on column public.marketplace_listing_health.shipping_cost_auxiliary_brl is
  'Simulação ML (ex.: shipping_options/free). Não substitui shipping_cost_amount (oficial Raio-X).';
comment on column public.marketplace_listing_health.shipping_cost_auxiliary_source is
  'Ex.: ml_shipping_options_free_simulation — referência apenas.';
