-- ======================================================================
-- Produtos: flags explícitas de importação do marketplace (UX e queries)
-- Complementa catalog_source / catalog_completeness sem removê-las.
-- ======================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'products'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_imported_from_marketplace'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN is_imported_from_marketplace boolean NOT NULL DEFAULT false;
      COMMENT ON COLUMN public.products.is_imported_from_marketplace IS
        'true quando o registro foi criado automaticamente a partir de anúncio.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'completion_status'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN completion_status text NOT NULL DEFAULT 'complete'
          CHECK (completion_status IN ('complete', 'incomplete'));
      COMMENT ON COLUMN public.products.completion_status IS
        'complete | incomplete — cadastro pronto para precificação interna completa.';
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
      ALTER TABLE public.products
        ADD COLUMN source_marketplace text;
      COMMENT ON COLUMN public.products.source_marketplace IS
        'Slug do canal de origem do import (ex.: mercado_livre).';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'source_external_listing_id'
    ) THEN
      ALTER TABLE public.products
        ADD COLUMN source_external_listing_id text;
      COMMENT ON COLUMN public.products.source_external_listing_id IS
        'ID público do anúncio na origem (ex.: MLB…).';
    END IF;
  END IF;
END $$;
