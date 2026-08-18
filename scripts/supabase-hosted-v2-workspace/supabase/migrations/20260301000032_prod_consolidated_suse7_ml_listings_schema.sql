-- ======================================================================
-- Suse7 — MIGRATION CONSOLIDADA (PROD / alinhamento com DEV)
-- PRÉ-REQUISITOS: `public.profiles`, `public.products`, `public.marketplace_listings`
-- (baseline Fase 1 / migrations anteriores). Sem `marketplace_listings`, falhará em FKs.
--
-- Objetivo: eliminar PostgreSQL 42703 em GET /api/ml/listings e handlers ML
-- associados, aplicando schema esperado pelo backend (tier 0 em health).
--
-- PRINCÍPIOS:
-- - Idempotente: CREATE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
-- - Sem DROP de dados, sem DELETE, sem remoção de colunas
-- - Backfills só preenchem NULL a partir de colunas legadas
-- - Compatível com Supabase SQL Editor (Postgres 14+)
--
-- Origem: consolidação das migrations em suse7-frontend/supabase/migrations/
-- (20260326…20260429) + scripts/sql marketplace_listing_health_history.
-- ======================================================================

BEGIN;

-- ======================================================================
-- BLOCO A — Registro de migrations aplicadas (auditoria)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.s7_schema_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_key text NOT NULL,
  migration_name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT 'manual',
  notes text,
  CONSTRAINT s7_schema_migrations_key_unique UNIQUE (migration_key)
);

COMMENT ON TABLE public.s7_schema_migrations IS
  'Registro manual ou via pipeline de migrations aplicadas no ambiente (PROD/DEV).';

ALTER TABLE public.s7_schema_migrations ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.s7_schema_migrations TO service_role;

-- ======================================================================
-- BLOCO B — products (catálogo / vínculo com anúncios)
-- ======================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'products'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'catalog_completeness'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN catalog_completeness text NOT NULL DEFAULT 'complete'
          CHECK (
            catalog_completeness IN (
              'complete',
              'incomplete_required_costs',
              'draft_imported_from_marketplace'
            )
          );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'catalog_source'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN catalog_source text
          CHECK (catalog_source IS NULL OR catalog_source IN ('manual', 'marketplace_import'));
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'cost_price' AND is_nullable = 'NO'
    ) THEN
      ALTER TABLE public.products ALTER COLUMN cost_price DROP NOT NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'packaging_cost' AND is_nullable = 'NO'
    ) THEN
      ALTER TABLE public.products ALTER COLUMN packaging_cost DROP NOT NULL;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'operational_cost' AND is_nullable = 'NO'
    ) THEN
      ALTER TABLE public.products ALTER COLUMN operational_cost DROP NOT NULL;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'cost_price'
    ) THEN
      ALTER TABLE public.products ALTER COLUMN cost_price DROP DEFAULT;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'packaging_cost'
    ) THEN
      ALTER TABLE public.products ALTER COLUMN packaging_cost DROP DEFAULT;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'operational_cost'
    ) THEN
      ALTER TABLE public.products ALTER COLUMN operational_cost DROP DEFAULT;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_imported_from_marketplace'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN is_imported_from_marketplace boolean NOT NULL DEFAULT false;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'completion_status'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN completion_status text NOT NULL DEFAULT 'complete'
          CHECK (completion_status IN ('complete', 'incomplete'));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'missing_required_costs'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN missing_required_costs boolean NOT NULL DEFAULT false;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'source_marketplace'
    ) THEN
      ALTER TABLE public.products ADD COLUMN source_marketplace text;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'source_external_listing_id'
    ) THEN
      ALTER TABLE public.products ADD COLUMN source_external_listing_id text;
    END IF;
  END IF;
END $$;

-- ======================================================================
-- BLOCO C — marketplace_listings (Fase 1 completa + enriquecimento + vínculo produto)
-- Nota: se a tabela não existir, esta migration assume baseline anterior aplicado.
-- ======================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'marketplace_listings'
  ) THEN
    ALTER TABLE public.marketplace_listings
      ADD COLUMN IF NOT EXISTS official_store_id text,
      ADD COLUMN IF NOT EXISTS inventory_id text,
      ADD COLUMN IF NOT EXISTS seller_custom_field text,
      ADD COLUMN IF NOT EXISTS warranty_text text,
      ADD COLUMN IF NOT EXISTS accepts_mercadopago boolean,
      ADD COLUMN IF NOT EXISTS tags jsonb,
      ADD COLUMN IF NOT EXISTS pictures_count integer,
      ADD COLUMN IF NOT EXISTS variations_count integer,
      ADD COLUMN IF NOT EXISTS shipping_mode text,
      ADD COLUMN IF NOT EXISTS shipping_free boolean,
      ADD COLUMN IF NOT EXISTS shipping_local_pick_up boolean,
      ADD COLUMN IF NOT EXISTS shipping_logistic_type text,
      ADD COLUMN IF NOT EXISTS attention_reason text;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'product_id'
    ) THEN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products') THEN
        ALTER TABLE public.marketplace_listings
          ADD COLUMN product_id uuid REFERENCES public.products (id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_marketplace_listings_user_product
          ON public.marketplace_listings (user_id, product_id)
          WHERE product_id IS NOT NULL;
      END IF;
    END IF;

    ALTER TABLE public.marketplace_listings
      ADD COLUMN IF NOT EXISTS financial_analysis_blocked boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS needs_attention boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS last_sync_reason text,
      ADD COLUMN IF NOT EXISTS last_auto_sync_at timestamptz,
      ADD COLUMN IF NOT EXISTS sync_compare_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- ======================================================================
-- BLOCO D — marketplace_listing_change_events (auditoria de sync)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.marketplace_listing_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_listing_id text NOT NULL,
  reason text NOT NULL,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_change_listing_created
  ON public.marketplace_listing_change_events (listing_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_change_user_created
  ON public.marketplace_listing_change_events (user_id, created_at DESC);

ALTER TABLE public.marketplace_listing_change_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_listing_change_events_select_own ON public.marketplace_listing_change_events;
CREATE POLICY marketplace_listing_change_events_select_own ON public.marketplace_listing_change_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON public.marketplace_listing_change_events TO authenticated;
GRANT ALL ON public.marketplace_listing_change_events TO service_role;

-- ======================================================================
-- BLOCO E — marketplace_listing_health (tabela base + colunas pricing/payout/frete v2)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.marketplace_listing_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_listing_id text NOT NULL,
  visits integer,
  orders_count integer,
  conversion_rate numeric(18, 6),
  sale_fee_percent numeric(18, 6),
  sale_fee_amount numeric(18, 6),
  shipping_cost numeric(18, 6),
  net_receivable numeric(18, 6),
  promotion_price numeric(18, 6),
  listing_quality_score numeric(18, 6),
  listing_quality_status text,
  listing_quality_substatus text,
  experience_status text,
  experience_substatus text,
  shipping_mode text,
  shipping_logistic_type text,
  shipping_tags jsonb,
  marketplace_messages jsonb,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_imported_at timestamptz NOT NULL DEFAULT now(),
  api_last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_listing_health_user_mkt_listing_unique UNIQUE (user_id, marketplace, external_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_health_user_mkt
  ON public.marketplace_listing_health (user_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_health_external_listing
  ON public.marketplace_listing_health (external_listing_id);

ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS list_or_original_price_brl numeric(18, 6),
  ADD COLUMN IF NOT EXISTS promotional_price_brl numeric(18, 6),
  ADD COLUMN IF NOT EXISTS has_product_link boolean,
  ADD COLUMN IF NOT EXISTS has_complete_costs boolean,
  ADD COLUMN IF NOT EXISTS product_health_status text,
  ADD COLUMN IF NOT EXISTS marketplace_sale_price_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_payout_currency text DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS marketplace_payout_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS shipping_cost_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS shipping_cost_currency text,
  ADD COLUMN IF NOT EXISTS shipping_cost_source text,
  ADD COLUMN IF NOT EXISTS shipping_cost_context text,
  ADD COLUMN IF NOT EXISTS shipping_cost_label text,
  ADD COLUMN IF NOT EXISTS marketplace_payout_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_payout_amount_brl numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_payout_source text,
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_amount_brl numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_source text,
  ADD COLUMN IF NOT EXISTS marketplace_cost_reduction_label text;

ALTER TABLE public.marketplace_listing_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_listing_health_select_own ON public.marketplace_listing_health;
CREATE POLICY marketplace_listing_health_select_own ON public.marketplace_listing_health
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON public.marketplace_listing_health TO authenticated;
GRANT ALL ON public.marketplace_listing_health TO service_role;

-- ======================================================================
-- BLOCO F — marketplace_listing_snapshots + coluna payout (auditoria de preço)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.marketplace_listing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings(id) ON DELETE CASCADE,
  product_id uuid NULL REFERENCES public.products(id) ON DELETE SET NULL,
  marketplace text NOT NULL,
  price numeric(14,2) NULL,
  promotion_price numeric(14,2) NULL,
  sale_fee_amount numeric(14,2) NULL,
  shipping_cost numeric(14,2) NULL,
  net_receivable numeric(14,2) NULL,
  visits integer NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.marketplace_listing_snapshots
  ADD COLUMN IF NOT EXISTS marketplace_payout_amount numeric(14, 2);

CREATE INDEX IF NOT EXISTS idx_listing_snapshots_listing_captured
  ON public.marketplace_listing_snapshots (listing_id, captured_at desc);

CREATE INDEX IF NOT EXISTS idx_listing_snapshots_product_captured
  ON public.marketplace_listing_snapshots (product_id, captured_at desc);

CREATE INDEX IF NOT EXISTS idx_listing_snapshots_marketplace_captured
  ON public.marketplace_listing_snapshots (marketplace, captured_at desc);

GRANT ALL ON public.marketplace_listing_snapshots TO service_role;

-- ======================================================================
-- BLOCO G — marketplace_listing_health_history (snapshots financeiros)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.marketplace_listing_health_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  marketplace_listing_health_id uuid NOT NULL REFERENCES public.marketplace_listing_health (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  marketplace text NOT NULL,
  external_listing_id text NOT NULL,
  list_or_original_price_brl numeric(14, 2),
  promotional_price_brl numeric(14, 2),
  sale_fee_percent numeric(10, 4),
  sale_fee_amount numeric(14, 2),
  shipping_cost_amount numeric(14, 2),
  shipping_cost_currency text DEFAULT 'BRL',
  shipping_cost_source text,
  shipping_cost_context text,
  shipping_cost_label text,
  marketplace_payout_amount numeric(14, 2),
  marketplace_payout_currency text DEFAULT 'BRL',
  marketplace_payout_source text,
  marketplace_cost_reduction_amount numeric(14, 2),
  marketplace_cost_reduction_source text,
  marketplace_cost_reduction_label text,
  raw_json jsonb,
  snapshot_reason text NOT NULL,
  snapshot_source text NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_listing_health_history_health_id_created_at_idx
  ON public.marketplace_listing_health_history (marketplace_listing_health_id, created_at desc);

CREATE INDEX IF NOT EXISTS marketplace_listing_health_history_user_ext_idx
  ON public.marketplace_listing_health_history (user_id, marketplace, external_listing_id, created_at desc);

CREATE OR REPLACE FUNCTION public.snapshot_marketplace_listing_health(
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
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.marketplace_listing_health_history (
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
  ) VALUES (
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
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_marketplace_listing_health(
  uuid, uuid, text, text, numeric, numeric, numeric, numeric, numeric, text, text, text, text, numeric, text, text, numeric, text, text, jsonb, text, text
) TO service_role;

-- ======================================================================
-- BLOCO H — Vendas ML (sales_orders, itens, métricas agregadas, auditoria pedido)
-- ======================================================================
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

CREATE INDEX IF NOT EXISTS idx_sales_order_items_external_listing
  ON public.sales_order_items (external_listing_id);

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

ALTER TABLE public.listing_sales_metrics
  ADD COLUMN IF NOT EXISTS commission_amount_total numeric(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_share_total numeric(18, 6) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_listing_sales_metrics_user_mkt
  ON public.listing_sales_metrics (user_id, marketplace);

CREATE TABLE IF NOT EXISTS public.order_raw_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_raw_snapshots_sales_order_id
  ON public.order_raw_snapshots (sales_order_id);

GRANT ALL ON public.sales_orders TO service_role;
GRANT ALL ON public.sales_order_items TO service_role;
GRANT ALL ON public.listing_sales_metrics TO service_role;
GRANT ALL ON public.order_raw_snapshots TO service_role;

-- ======================================================================
-- BLOCO I — ml_tokens (marketplace slug — OAuth ML)
-- ======================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ml_tokens'
  ) THEN
    ALTER TABLE public.ml_tokens
      ADD COLUMN IF NOT EXISTS marketplace text NOT NULL DEFAULT 'mercado_livre';
  END IF;
END $$;

-- ======================================================================
-- BLOCO J — Backfills não destrutivos (health + snapshots)
-- ======================================================================
UPDATE public.marketplace_listing_health
SET promotional_price_brl = promotion_price
WHERE promotional_price_brl IS NULL
  AND promotion_price IS NOT NULL;

UPDATE public.marketplace_listing_health
SET shipping_cost_amount = round(shipping_cost::numeric, 2)
WHERE shipping_cost_amount IS NULL
  AND shipping_cost IS NOT NULL;

UPDATE public.marketplace_listing_health
SET shipping_cost_currency = 'BRL'
WHERE shipping_cost_currency IS NULL
  AND (shipping_cost_amount IS NOT NULL OR shipping_cost IS NOT NULL);

UPDATE public.marketplace_listing_health
SET marketplace_payout_amount_brl = round(net_receivable::numeric, 2)
WHERE net_receivable IS NOT NULL
  AND marketplace_payout_amount_brl IS NULL;

UPDATE public.marketplace_listing_health
SET marketplace_payout_amount = round(net_receivable::numeric, 2)
WHERE net_receivable IS NOT NULL
  AND marketplace_payout_amount IS NULL;

UPDATE public.marketplace_listing_health
SET marketplace_payout_source = coalesce(
  marketplace_payout_source,
  'legacy_net_receivable_backfill'
)
WHERE marketplace_payout_amount_brl IS NOT NULL
  AND (marketplace_payout_source IS NULL OR btrim(marketplace_payout_source) = '');

UPDATE public.marketplace_listing_snapshots
SET marketplace_payout_amount = round(net_receivable::numeric, 2)
WHERE marketplace_payout_amount IS NULL
  AND net_receivable IS NOT NULL;

-- Tarifa: invalidar % irreais (re-sync posterior)
UPDATE public.marketplace_listing_health
SET
  sale_fee_percent = NULL,
  sale_fee_amount = NULL
WHERE sale_fee_percent IS NOT NULL
  AND sale_fee_percent::numeric > 30;

UPDATE public.marketplace_listing_health h
SET sale_fee_percent = ROUND(
  (
    (h.sale_fee_amount::numeric / NULLIF(
      COALESCE(
        NULLIF(h.promotional_price_brl, 0::numeric),
        NULLIF(h.promotion_price, 0::numeric),
        l.price::numeric
      ),
      0::numeric
    )) * 100
  )::numeric,
  2
)
FROM public.marketplace_listings l
WHERE l.user_id = h.user_id
  AND l.marketplace = h.marketplace
  AND l.external_listing_id = h.external_listing_id
  AND h.sale_fee_percent IS NULL
  AND h.sale_fee_amount IS NOT NULL
  AND h.sale_fee_amount > 0
  AND COALESCE(
    NULLIF(h.promotional_price_brl, 0::numeric),
    NULLIF(h.promotion_price, 0::numeric),
    l.price::numeric
  ) IS NOT NULL
  AND COALESCE(
    NULLIF(h.promotional_price_brl, 0::numeric),
    NULLIF(h.promotion_price, 0::numeric),
    l.price::numeric
  ) > 0
  AND (
    (h.sale_fee_amount::numeric / NULLIF(
      COALESCE(
        NULLIF(h.promotional_price_brl, 0::numeric),
        NULLIF(h.promotion_price, 0::numeric),
        l.price::numeric
      ),
      0::numeric
    )) * 100
  ) <= 30;

COMMIT;

-- ======================================================================
-- REGISTRO (executar após COMMIT bem-sucedido; idempotente)
-- ======================================================================
INSERT INTO public.s7_schema_migrations (migration_key, migration_name, applied_by, notes)
VALUES (
  '20260415120000_prod_consolidated_suse7_ml_listings_schema',
  'PROD Suse7 — ML listings + marketplace_listing_health (tier 0) + snapshots + vendas + health_history',
  'manual-sql-editor',
  'Consolidado idempotente: colunas listings (enrichment, product_id, sync_compare_snapshot), health (list/promo, payout, shipping v2, subsídio), marketplace_listing_snapshots.marketplace_payout_amount, listing_sales_metrics commission/shipping, sales_* + order_raw_snapshots, marketplace_listing_health_history + snapshot_marketplace_listing_health, ml_tokens.marketplace, backfills seguros, invalidação tarifa >30%.'
)
ON CONFLICT (migration_key) DO NOTHING;

-- ======================================================================
-- FIM
-- ======================================================================
