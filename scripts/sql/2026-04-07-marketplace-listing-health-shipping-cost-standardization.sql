-- Suse7 — padronização de campos de custo de envio no marketplace_listing_health
-- Idempotente: pode rodar múltiplas vezes com segurança.

alter table if exists public.marketplace_listing_health
  add column if not exists shipping_cost_amount numeric(14,2),
  add column if not exists shipping_cost_currency text default 'BRL',
  add column if not exists shipping_cost_source text,
  add column if not exists shipping_cost_context text,
  add column if not exists shipping_cost_label text;

-- Backfill inicial: reaproveita shipping_cost legado quando o novo campo ainda está vazio.
update public.marketplace_listing_health
set
  shipping_cost_amount = coalesce(shipping_cost_amount, shipping_cost),
  shipping_cost_currency = coalesce(nullif(shipping_cost_currency, ''), 'BRL'),
  shipping_cost_label = coalesce(nullif(shipping_cost_label, ''), 'Custo de envio do Mercado Livre')
where shipping_cost_amount is null
   or shipping_cost_currency is null
   or shipping_cost_label is null;
