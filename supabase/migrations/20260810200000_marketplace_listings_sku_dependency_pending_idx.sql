-- SSOT da fila de dependência SKU/produto:
-- marketplace_listings.product_id IS NULL, sem filtro por status.
create index if not exists marketplace_listings_user_sku_dependency_pending_idx
  on public.marketplace_listings (user_id)
  where product_id is null;
