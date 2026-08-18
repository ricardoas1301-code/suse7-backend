-- ======================================================================
-- FASE 3 — Vendas / pedidos Mercado Livre (multi-marketplace ready)
-- Memória histórica no Suse7: independente do estado atual do anúncio no ML.
-- Sem RLS nesta fase (backend usa service_role).
-- ======================================================================

-- ----------------------------------------------------------------------
-- 1) sales_orders — cabeçalho do pedido
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_order_id text NOT NULL,
  external_pack_id text,
  order_status text,
  order_substatus text,
  date_created_marketplace timestamptz,
  date_closed_marketplace timestamptz,
  last_updated_marketplace timestamptz,
  paid_at timestamptz,
  currency_id text,
  total_amount numeric(18, 6),
  shipping_amount numeric(18, 6),
  tax_amount numeric(18, 6),
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_imported_at timestamptz NOT NULL DEFAULT now(),
  api_last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_orders_marketplace_external_order_unique UNIQUE (marketplace, external_order_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_orders_user_marketplace
  ON public.sales_orders (user_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_sales_orders_status
  ON public.sales_orders (order_status);

CREATE INDEX IF NOT EXISTS idx_sales_orders_date_created_desc
  ON public.sales_orders (date_created_marketplace DESC NULLS LAST);

COMMENT ON TABLE public.sales_orders IS 'Pedidos importados de marketplaces (histórico próprio Suse7).';

-- ----------------------------------------------------------------------
-- 2) sales_order_items — linhas do pedido
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_order_item_id text,
  external_listing_id text,
  external_variation_id text,
  title_snapshot text,
  sku_snapshot text,
  quantity integer NOT NULL DEFAULT 1,
  unit_price numeric(18, 6),
  gross_amount numeric(18, 6),
  fee_amount numeric(18, 6),
  shipping_share_amount numeric(18, 6),
  tax_amount numeric(18, 6),
  net_amount numeric(18, 6),
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_imported_at timestamptz NOT NULL DEFAULT now(),
  api_last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_order_items_order_id
  ON public.sales_order_items (sales_order_id);

CREATE INDEX IF NOT EXISTS idx_sales_order_items_user_marketplace
  ON public.sales_order_items (user_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_sales_order_items_external_listing
  ON public.sales_order_items (external_listing_id);

CREATE INDEX IF NOT EXISTS idx_sales_order_items_external_variation
  ON public.sales_order_items (external_variation_id);

COMMENT ON TABLE public.sales_order_items IS 'Itens de pedido; resync: delete por sales_order_id + insert (id estável do ML em external_order_item_id quando existir).';

-- ----------------------------------------------------------------------
-- 3) listing_sales_metrics — consolidado por anúncio (derivado dos itens)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.listing_sales_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_listing_id text NOT NULL,
  qty_sold_total integer NOT NULL DEFAULT 0,
  gross_revenue_total numeric(18, 6) NOT NULL DEFAULT 0,
  net_revenue_total numeric(18, 6) NOT NULL DEFAULT 0,
  orders_count integer NOT NULL DEFAULT 0,
  last_sale_at timestamptz,
  last_sync_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_sales_metrics_user_mkt_listing_unique UNIQUE (user_id, marketplace, external_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_sales_metrics_user_mkt
  ON public.listing_sales_metrics (user_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_listing_sales_metrics_last_sale_desc
  ON public.listing_sales_metrics (last_sale_at DESC NULLS LAST);

COMMENT ON TABLE public.listing_sales_metrics IS 'Agregado por anúncio; recalculado no fim do sync de vendas (sem soma incremental duplicada).';

-- ----------------------------------------------------------------------
-- 4) order_raw_snapshots — auditoria / reprocessamento
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_raw_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_raw_snapshots_sales_order_id
  ON public.order_raw_snapshots (sales_order_id);

-- ----------------------------------------------------------------------
-- Grants (service_role = backend)
-- ----------------------------------------------------------------------
GRANT ALL ON public.sales_orders TO service_role;
GRANT ALL ON public.sales_order_items TO service_role;
GRANT ALL ON public.listing_sales_metrics TO service_role;
GRANT ALL ON public.order_raw_snapshots TO service_role;
