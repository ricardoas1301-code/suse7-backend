-- ============================================================
-- S7 | Hardening multi-conta para vendas/clientes/listings
-- Idempotente e seguro para ambiente DEV com histórico legado.
-- ============================================================

-- --------------------------------------------
-- sales_orders
-- --------------------------------------------
ALTER TABLE IF EXISTS public.sales_orders
  ADD COLUMN IF NOT EXISTS marketplace text,
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid,
  ADD COLUMN IF NOT EXISTS seller_company_id uuid,
  ADD COLUMN IF NOT EXISTS raw_json jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.sales_orders') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_marketplace_account_id_fkey') THEN
      ALTER TABLE public.sales_orders
        ADD CONSTRAINT sales_orders_marketplace_account_id_fkey
        FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_orders_seller_company_id_fkey') THEN
      ALTER TABLE public.sales_orders
        ADD CONSTRAINT sales_orders_seller_company_id_fkey
        FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- --------------------------------------------
-- sales_order_items
-- --------------------------------------------
ALTER TABLE IF EXISTS public.sales_order_items
  ADD COLUMN IF NOT EXISTS marketplace text,
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid,
  ADD COLUMN IF NOT EXISTS seller_company_id uuid,
  ADD COLUMN IF NOT EXISTS external_order_id text,
  ADD COLUMN IF NOT EXISTS external_item_id text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS raw_json jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.sales_order_items') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_order_items_marketplace_account_id_fkey') THEN
      ALTER TABLE public.sales_order_items
        ADD CONSTRAINT sales_order_items_marketplace_account_id_fkey
        FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_order_items_seller_company_id_fkey') THEN
      ALTER TABLE public.sales_order_items
        ADD CONSTRAINT sales_order_items_seller_company_id_fkey
        FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- --------------------------------------------
-- marketplace_customers
-- --------------------------------------------
ALTER TABLE IF EXISTS public.marketplace_customers
  ADD COLUMN IF NOT EXISTS marketplace text,
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid,
  ADD COLUMN IF NOT EXISTS seller_company_id uuid,
  ADD COLUMN IF NOT EXISTS external_customer_id text,
  ADD COLUMN IF NOT EXISTS raw_json jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.marketplace_customers') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_customers_marketplace_account_id_fkey') THEN
      ALTER TABLE public.marketplace_customers
        ADD CONSTRAINT marketplace_customers_marketplace_account_id_fkey
        FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_customers_seller_company_id_fkey') THEN
      ALTER TABLE public.marketplace_customers
        ADD CONSTRAINT marketplace_customers_seller_company_id_fkey
        FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- --------------------------------------------
-- marketplace_listings (preparação multiconta)
-- --------------------------------------------
ALTER TABLE IF EXISTS public.marketplace_listings
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid,
  ADD COLUMN IF NOT EXISTS seller_company_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.marketplace_listings') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_listings_marketplace_account_id_fkey') THEN
      ALTER TABLE public.marketplace_listings
        ADD CONSTRAINT marketplace_listings_marketplace_account_id_fkey
        FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_listings_seller_company_id_fkey') THEN
      ALTER TABLE public.marketplace_listings
        ADD CONSTRAINT marketplace_listings_seller_company_id_fkey
        FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- --------------------------------------------
-- Índices de performance
-- --------------------------------------------
CREATE INDEX IF NOT EXISTS sales_orders_user_id_idx ON public.sales_orders(user_id);
CREATE INDEX IF NOT EXISTS sales_orders_seller_company_id_idx ON public.sales_orders(seller_company_id);
CREATE INDEX IF NOT EXISTS sales_orders_marketplace_account_id_idx ON public.sales_orders(marketplace_account_id);
CREATE INDEX IF NOT EXISTS sales_orders_marketplace_idx ON public.sales_orders(marketplace);
CREATE INDEX IF NOT EXISTS sales_orders_external_order_id_idx ON public.sales_orders(external_order_id);
CREATE INDEX IF NOT EXISTS sales_orders_order_date_idx ON public.sales_orders(date_created_marketplace);

CREATE INDEX IF NOT EXISTS sales_order_items_user_id_idx ON public.sales_order_items(user_id);
CREATE INDEX IF NOT EXISTS sales_order_items_seller_company_id_idx ON public.sales_order_items(seller_company_id);
CREATE INDEX IF NOT EXISTS sales_order_items_marketplace_account_id_idx ON public.sales_order_items(marketplace_account_id);
CREATE INDEX IF NOT EXISTS sales_order_items_external_order_id_idx ON public.sales_order_items(external_order_id);
CREATE INDEX IF NOT EXISTS sales_order_items_sku_idx ON public.sales_order_items(sku);
CREATE INDEX IF NOT EXISTS sales_order_items_external_item_id_idx ON public.sales_order_items(external_item_id);

CREATE INDEX IF NOT EXISTS marketplace_customers_user_id_idx ON public.marketplace_customers(user_id);
CREATE INDEX IF NOT EXISTS marketplace_customers_seller_company_id_idx ON public.marketplace_customers(seller_company_id);
CREATE INDEX IF NOT EXISTS marketplace_customers_marketplace_account_id_idx ON public.marketplace_customers(marketplace_account_id);
CREATE INDEX IF NOT EXISTS marketplace_customers_marketplace_idx ON public.marketplace_customers(marketplace);
CREATE INDEX IF NOT EXISTS marketplace_customers_external_customer_id_idx ON public.marketplace_customers(external_customer_id);

-- --------------------------------------------
-- Idempotência multi-conta (índices únicos parciais)
-- --------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_marketplace_account_order_uidx
  ON public.sales_orders (marketplace, marketplace_account_id, external_order_id)
  WHERE marketplace_account_id IS NOT NULL AND external_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_items_marketplace_account_item_uidx
  ON public.sales_order_items (marketplace, marketplace_account_id, external_order_id, external_item_id)
  WHERE marketplace_account_id IS NOT NULL
    AND external_order_id IS NOT NULL
    AND external_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_customers_marketplace_account_customer_uidx
  ON public.marketplace_customers (marketplace, marketplace_account_id, external_customer_id)
  WHERE marketplace_account_id IS NOT NULL AND external_customer_id IS NOT NULL;

