-- S1 — Enriquecimento produto na importação marketplace (origem + estoque)
-- Idempotente.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS marketplace_imported_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketplace_last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS stock_source text;

COMMENT ON COLUMN public.products.marketplace_imported_at IS
  'Primeira importação/enriquecimento automático via marketplace.';
COMMENT ON COLUMN public.products.marketplace_last_synced_at IS
  'Último resync automático de campos marketplace (S1).';
COMMENT ON COLUMN public.products.stock_source IS
  'Origem do estoque: marketplace | manual | system. Resync ML só sobrescreve quando marketplace.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_source_check'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_stock_source_check
      CHECK (stock_source IS NULL OR stock_source IN ('marketplace', 'manual', 'system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS products_marketplace_last_synced_at_idx
  ON public.products (user_id, marketplace_last_synced_at DESC NULLS LAST)
  WHERE marketplace_last_synced_at IS NOT NULL;
