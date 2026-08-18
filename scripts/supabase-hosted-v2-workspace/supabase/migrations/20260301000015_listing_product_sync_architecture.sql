-- ======================================================================
-- Arquitetura: vínculo listing ↔ produto (SKU), snapshot leve p/ auto-sync,
-- completude de catálogo / custos, histórico de alterações relevantes.
-- Multi-marketplace: marketplace text + external_listing_id (conta/CNPJ futuro: colunas opcionais).
-- ======================================================================

-- ----------------------------------------------------------------------
-- products: completude e origem do cadastro (UX + regras de bloqueio)
-- ----------------------------------------------------------------------
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
      COMMENT ON COLUMN public.products.catalog_completeness IS
        'complete = custos obrigatórios preenchidos; incomplete_* = bloqueia análise financeira completa nos anúncios vinculados.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'catalog_source'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN catalog_source text
          CHECK (catalog_source IS NULL OR catalog_source IN ('manual', 'marketplace_import'));
      COMMENT ON COLUMN public.products.catalog_source IS
        'manual | marketplace_import — facilita UX e evolução multi-canal.';
    END IF;

    -- Custos explicitamente ausentes em imports (sem inferir "completo" por DEFAULT 0)
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
    ALTER TABLE public.products ALTER COLUMN cost_price DROP DEFAULT;
    ALTER TABLE public.products ALTER COLUMN packaging_cost DROP DEFAULT;
    ALTER TABLE public.products ALTER COLUMN operational_cost DROP DEFAULT;
  END IF;
END $$;

-- ----------------------------------------------------------------------
-- marketplace_listings: produto, flags operacionais, snapshot comparável
-- ----------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'marketplace_listings'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'product_id'
    ) THEN
      ALTER TABLE public.marketplace_listings
        ADD COLUMN product_id uuid REFERENCES public.products (id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_marketplace_listings_user_product
        ON public.marketplace_listings (user_id, product_id)
        WHERE product_id IS NOT NULL;
      COMMENT ON COLUMN public.marketplace_listings.product_id IS
        'Produto Suse7 vinculado (SKU).';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'financial_analysis_blocked'
    ) THEN
      ALTER TABLE public.marketplace_listings
        ADD COLUMN financial_analysis_blocked boolean NOT NULL DEFAULT false;
      COMMENT ON COLUMN public.marketplace_listings.financial_analysis_blocked IS
        'true quando produto vinculado não tem custos completos — UI de precificação/análise limitada.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'needs_attention'
    ) THEN
      ALTER TABLE public.marketplace_listings
        ADD COLUMN needs_attention boolean NOT NULL DEFAULT false;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'last_sync_reason'
    ) THEN
      ALTER TABLE public.marketplace_listings
        ADD COLUMN last_sync_reason text;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'last_auto_sync_at'
    ) THEN
      ALTER TABLE public.marketplace_listings
        ADD COLUMN last_auto_sync_at timestamptz;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'marketplace_listings' AND column_name = 'sync_compare_snapshot'
    ) THEN
      ALTER TABLE public.marketplace_listings
        ADD COLUMN sync_compare_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
      COMMENT ON COLUMN public.marketplace_listings.sync_compare_snapshot IS
        'Fingerprint leve (preço, taxas, visitas, SKU, título, etc.) para auto-sync sem reprocessar tudo.';
    END IF;
  END IF;
END $$;

-- ----------------------------------------------------------------------
-- Histórico de mudanças relevantes (preço, promo, frete, saúde, status…)
-- ----------------------------------------------------------------------
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

COMMENT ON TABLE public.marketplace_listing_change_events IS
  'Eventos de mudança detectados na auto-sync ou importação (motivos: price_changed, health_changed, …).';

ALTER TABLE public.marketplace_listing_change_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_listing_change_events_select_own ON public.marketplace_listing_change_events;
CREATE POLICY marketplace_listing_change_events_select_own ON public.marketplace_listing_change_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON public.marketplace_listing_change_events TO authenticated;
GRANT ALL ON public.marketplace_listing_change_events TO service_role;
