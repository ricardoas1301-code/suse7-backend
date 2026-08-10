-- =============================================================================
-- SSOT financeiro P0 — unicidade canônica de linha (DEV)
-- UNIQUE não parcial nas 4 colunas — compatível com Supabase/PostgREST upsert
-- onConflict sem inferência de índice parcial.
-- Legacy rows com external_order_item_id NULL permanecem (NULL ≠ NULL em UNIQUE).
-- external_item_id NÃO é alterado nesta migration (auditoria índice legado pendente).
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_items_marketplace_order_line_uidx
  ON public.sales_order_items (
    marketplace,
    marketplace_account_id,
    external_order_id,
    external_order_item_id
  );

COMMENT ON INDEX public.sales_order_items_marketplace_order_line_uidx IS
  'Idempotência linha ML: upsert PostgREST onConflict (marketplace, marketplace_account_id, external_order_id, external_order_item_id).';
