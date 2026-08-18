-- S1.14 — Estoque virtual override por anúncio (configuração interna SUS7)
-- Não sincroniza estoque no marketplace; prepara automação futura.

create table if not exists public.marketplace_listing_virtual_stock_settings (
  listing_id uuid primary key references public.marketplace_listings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  override_enabled boolean not null default false,
  virtual_stock_value integer null,
  updated_at timestamptz null,
  updated_by uuid null references auth.users(id),
  constraint marketplace_listing_virtual_stock_value_non_negative
    check (virtual_stock_value is null or virtual_stock_value >= 0)
);

create index if not exists idx_marketplace_listing_virtual_stock_settings_user
  on public.marketplace_listing_virtual_stock_settings(user_id);

alter table public.marketplace_listing_virtual_stock_settings enable row level security;

drop policy if exists "marketplace_listing_virtual_stock_settings_select_own"
  on public.marketplace_listing_virtual_stock_settings;
create policy "marketplace_listing_virtual_stock_settings_select_own"
  on public.marketplace_listing_virtual_stock_settings
  for select
  using (auth.uid() = user_id);

drop policy if exists "marketplace_listing_virtual_stock_settings_insert_own"
  on public.marketplace_listing_virtual_stock_settings;
create policy "marketplace_listing_virtual_stock_settings_insert_own"
  on public.marketplace_listing_virtual_stock_settings
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "marketplace_listing_virtual_stock_settings_update_own"
  on public.marketplace_listing_virtual_stock_settings;
create policy "marketplace_listing_virtual_stock_settings_update_own"
  on public.marketplace_listing_virtual_stock_settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
