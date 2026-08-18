-- ======================================================
-- marketplace_listing_snapshots
-- Histórico append-only de preço + vendas por anúncio.
-- ======================================================

create table if not exists public.marketplace_listing_snapshots (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.marketplace_listings(id) on delete cascade,
  product_id uuid null references public.products(id) on delete set null,
  marketplace text not null,
  price numeric(14,2) null,
  promotion_price numeric(14,2) null,
  sale_fee_amount numeric(14,2) null,
  shipping_cost numeric(14,2) null,
  net_receivable numeric(14,2) null,
  visits integer not null default 0,
  orders integer not null default 0,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_listing_snapshots_listing_captured
  on public.marketplace_listing_snapshots (listing_id, captured_at desc);

create index if not exists idx_listing_snapshots_product_captured
  on public.marketplace_listing_snapshots (product_id, captured_at desc);

create index if not exists idx_listing_snapshots_marketplace_captured
  on public.marketplace_listing_snapshots (marketplace, captured_at desc);
