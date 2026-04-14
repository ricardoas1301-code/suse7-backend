-- Suse7 — repasse unitário e subsídio/redução de custos ML (marketplace_listing_health)
-- Idempotente: pode rodar múltiplas vezes.

alter table if exists public.marketplace_listing_health
  add column if not exists marketplace_payout_amount numeric(14,2),
  add column if not exists marketplace_payout_amount_brl numeric(14,2),
  add column if not exists marketplace_payout_source text,
  add column if not exists marketplace_cost_reduction_amount numeric(14,2),
  add column if not exists marketplace_cost_reduction_amount_brl numeric(14,2),
  add column if not exists marketplace_cost_reduction_source text,
  add column if not exists marketplace_cost_reduction_label text;
