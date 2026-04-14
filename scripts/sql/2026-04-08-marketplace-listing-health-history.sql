-- Suse7 — histórico financeiro de marketplace_listing_health (snapshots para IA / auditoria)
-- Idempotente: pode rodar múltiplas vezes.

create table if not exists public.marketplace_listing_health_history (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  marketplace_listing_health_id uuid not null references public.marketplace_listing_health (id) on delete cascade,
  user_id uuid not null,
  marketplace text not null,
  external_listing_id text not null,
  list_or_original_price_brl numeric(14, 2),
  promotional_price_brl numeric(14, 2),
  sale_fee_percent numeric(10, 4),
  sale_fee_amount numeric(14, 2),
  shipping_cost_amount numeric(14, 2),
  shipping_cost_currency text default 'BRL',
  shipping_cost_source text,
  shipping_cost_context text,
  shipping_cost_label text,
  marketplace_payout_amount numeric(14, 2),
  marketplace_payout_currency text default 'BRL',
  marketplace_payout_source text,
  marketplace_cost_reduction_amount numeric(14, 2),
  marketplace_cost_reduction_source text,
  marketplace_cost_reduction_label text,
  raw_json jsonb,
  snapshot_reason text not null,
  snapshot_source text not null
);

create index if not exists marketplace_listing_health_history_health_id_created_at_idx
  on public.marketplace_listing_health_history (marketplace_listing_health_id, created_at desc);

create index if not exists marketplace_listing_health_history_user_ext_idx
  on public.marketplace_listing_health_history (user_id, marketplace, external_listing_id, created_at desc);

comment on table public.marketplace_listing_health_history is
  'Snapshots financeiros do anúncio (preço, taxas, frete, payout, subsídio). Gravados pelo backend quando há mudança relevante.';

-- snapshot_reason sugerido: health_sync | manual_backfill | repricing_update | financial_correction | import_sync
-- snapshot_source sugerido: ml_health_sync | ml_backfill | admin_fix | migration | scheduled_job

create or replace function public.snapshot_marketplace_listing_health(
  p_marketplace_listing_health_id uuid,
  p_user_id uuid,
  p_marketplace text,
  p_external_listing_id text,
  p_list_or_original_price_brl numeric,
  p_promotional_price_brl numeric,
  p_sale_fee_percent numeric,
  p_sale_fee_amount numeric,
  p_shipping_cost_amount numeric,
  p_shipping_cost_currency text,
  p_shipping_cost_source text,
  p_shipping_cost_context text,
  p_shipping_cost_label text,
  p_marketplace_payout_amount numeric,
  p_marketplace_payout_currency text,
  p_marketplace_payout_source text,
  p_marketplace_cost_reduction_amount numeric,
  p_marketplace_cost_reduction_source text,
  p_marketplace_cost_reduction_label text,
  p_raw_json jsonb,
  p_snapshot_reason text,
  p_snapshot_source text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.marketplace_listing_health_history (
    marketplace_listing_health_id,
    user_id,
    marketplace,
    external_listing_id,
    list_or_original_price_brl,
    promotional_price_brl,
    sale_fee_percent,
    sale_fee_amount,
    shipping_cost_amount,
    shipping_cost_currency,
    shipping_cost_source,
    shipping_cost_context,
    shipping_cost_label,
    marketplace_payout_amount,
    marketplace_payout_currency,
    marketplace_payout_source,
    marketplace_cost_reduction_amount,
    marketplace_cost_reduction_source,
    marketplace_cost_reduction_label,
    raw_json,
    snapshot_reason,
    snapshot_source
  ) values (
    p_marketplace_listing_health_id,
    p_user_id,
    p_marketplace,
    p_external_listing_id,
    p_list_or_original_price_brl,
    p_promotional_price_brl,
    p_sale_fee_percent,
    p_sale_fee_amount,
    p_shipping_cost_amount,
    coalesce(nullif(trim(p_shipping_cost_currency), ''), 'BRL'),
    p_shipping_cost_source,
    p_shipping_cost_context,
    p_shipping_cost_label,
    p_marketplace_payout_amount,
    coalesce(nullif(trim(p_marketplace_payout_currency), ''), 'BRL'),
    p_marketplace_payout_source,
    p_marketplace_cost_reduction_amount,
    p_marketplace_cost_reduction_source,
    p_marketplace_cost_reduction_label,
    p_raw_json,
    p_snapshot_reason,
    p_snapshot_source
  )
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.snapshot_marketplace_listing_health is
  'Insere um snapshot financeiro (uso opcional via SQL; o backend grava normalmente via insert direto).';
