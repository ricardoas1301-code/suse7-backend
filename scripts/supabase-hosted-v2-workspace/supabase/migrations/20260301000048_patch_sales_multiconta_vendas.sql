-- ============================================================
-- S7 | Patch definitivo multiconta - Vendas
-- Escopo: sales_orders + sales_order_items
-- Idempotente, sem quebra de legado
-- ============================================================

-- -----------------------------
-- sales_orders: colunas
-- -----------------------------
ALTER TABLE IF EXISTS public.sales_orders
  ADD COLUMN IF NOT EXISTS seller_company_id uuid,
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid;

DO $$
BEGIN
  IF to_regclass('public.sales_orders') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_seller_company_id_fkey'
    ) THEN
      ALTER TABLE public.sales_orders
        ADD CONSTRAINT sales_orders_seller_company_id_fkey
        FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_marketplace_account_id_fkey'
    ) THEN
      ALTER TABLE public.sales_orders
        ADD CONSTRAINT sales_orders_marketplace_account_id_fkey
        FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- -----------------------------
-- sales_order_items: colunas
-- -----------------------------
ALTER TABLE IF EXISTS public.sales_order_items
  ADD COLUMN IF NOT EXISTS seller_company_id uuid,
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid;

DO $$
BEGIN
  IF to_regclass('public.sales_order_items') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'sales_order_items_seller_company_id_fkey'
    ) THEN
      ALTER TABLE public.sales_order_items
        ADD CONSTRAINT sales_order_items_seller_company_id_fkey
        FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'sales_order_items_marketplace_account_id_fkey'
    ) THEN
      ALTER TABLE public.sales_order_items
        ADD CONSTRAINT sales_order_items_marketplace_account_id_fkey
        FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- -----------------------------
-- Índices base
-- -----------------------------
CREATE INDEX IF NOT EXISTS sales_orders_seller_company_id_idx
  ON public.sales_orders (seller_company_id);
CREATE INDEX IF NOT EXISTS sales_orders_marketplace_account_id_idx
  ON public.sales_orders (marketplace_account_id);

CREATE INDEX IF NOT EXISTS sales_order_items_seller_company_id_idx
  ON public.sales_order_items (seller_company_id);
CREATE INDEX IF NOT EXISTS sales_order_items_marketplace_account_id_idx
  ON public.sales_order_items (marketplace_account_id);
CREATE INDEX IF NOT EXISTS sales_order_items_sales_order_id_marketplace_account_id_idx
  ON public.sales_order_items (sales_order_id, marketplace_account_id);

-- Idempotência de pedidos por conta (somente quando conta presente)
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_marketplace_account_order_uidx
  ON public.sales_orders (marketplace, marketplace_account_id, external_order_id)
  WHERE marketplace_account_id IS NOT NULL AND external_order_id IS NOT NULL;

-- Índices condicionais por coluna opcional em sales_order_items
DO $$
BEGIN
  IF to_regclass('public.sales_order_items') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'sku'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS sales_order_items_marketplace_account_id_sku_idx
             ON public.sales_order_items (marketplace_account_id, sku)';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'external_item_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS sales_order_items_marketplace_account_id_external_item_id_idx
             ON public.sales_order_items (marketplace_account_id, external_item_id)';
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'external_order_item_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS sales_order_items_marketplace_account_id_external_order_item_id_idx
             ON public.sales_order_items (marketplace_account_id, external_order_item_id)';
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'item_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS sales_order_items_marketplace_account_id_item_id_idx
             ON public.sales_order_items (marketplace_account_id, item_id)';
  END IF;
END $$;

