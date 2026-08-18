-- ======================================================================
-- Migration: normalized_sku + índice único (SKU por seller)
-- Objetivo: garantir unicidade de SKU por user_id no banco
-- Validação por query já existe em ProductDomainService; este índice
-- reforça a regra no DB e melhora performance de lookups.
-- ======================================================================

-- Função: normaliza SKU (trim, uppercase, colapsar espaços)
CREATE OR REPLACE FUNCTION public.normalize_sku(val TEXT)
RETURNS TEXT AS $$
BEGIN
  IF val IS NULL OR val = '' THEN
    RETURN NULL;
  END IF;
  RETURN UPPER(TRIM(REGEXP_REPLACE(val, '\s+', ' ', 'g')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 1) products: coluna normalized_sku + índice único
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'normalized_sku'
    ) THEN
      ALTER TABLE public.products ADD COLUMN normalized_sku TEXT;
      UPDATE public.products SET normalized_sku = public.normalize_sku(sku) WHERE sku IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_products_user_normalized_sku
        ON public.products(user_id, normalized_sku)
        WHERE normalized_sku IS NOT NULL AND normalized_sku != '';
    END IF;
  END IF;
END $$;

-- 2) product_variants: coluna normalized_sku (índice único por user exigiria user_id)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'product_variants') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product_variants' AND column_name = 'normalized_sku'
    ) THEN
      ALTER TABLE public.product_variants ADD COLUMN normalized_sku TEXT;
      UPDATE public.product_variants SET normalized_sku = public.normalize_sku(sku) WHERE sku IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_product_variants_normalized_sku
        ON public.product_variants(normalized_sku)
        WHERE normalized_sku IS NOT NULL AND normalized_sku != '';
    END IF;
  END IF;
END $$;

-- Trigger: manter normalized_sku em products (ao insert/update)
CREATE OR REPLACE FUNCTION public.sync_products_normalized_sku()
RETURNS TRIGGER AS $$
BEGIN
  NEW.normalized_sku := public.normalize_sku(NEW.sku);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_products_normalized_sku ON public.products;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products') THEN
    CREATE TRIGGER tr_products_normalized_sku
      BEFORE INSERT OR UPDATE OF sku ON public.products
      FOR EACH ROW EXECUTE PROCEDURE public.sync_products_normalized_sku();
  END IF;
END $$;

-- Trigger: manter normalized_sku em product_variants
CREATE OR REPLACE FUNCTION public.sync_product_variants_normalized_sku()
RETURNS TRIGGER AS $$
BEGIN
  NEW.normalized_sku := public.normalize_sku(NEW.sku);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_product_variants_normalized_sku ON public.product_variants;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'product_variants') THEN
    CREATE TRIGGER tr_product_variants_normalized_sku
      BEFORE INSERT OR UPDATE OF sku ON public.product_variants
      FOR EACH ROW EXECUTE PROCEDURE public.sync_product_variants_normalized_sku();
  END IF;
END $$;
