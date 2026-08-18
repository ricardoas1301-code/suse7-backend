-- ======================================================================
-- SKU: preservar maiúsculas/minúsculas (coluna sku continua literal do usuário;
-- normalized_sku passa a ser só trim + colapso de espaços, sem UPPER).
-- ======================================================================

CREATE OR REPLACE FUNCTION public.normalize_sku(val TEXT)
RETURNS TEXT AS $$
BEGIN
  IF val IS NULL OR val = '' THEN
    RETURN NULL;
  END IF;
  RETURN TRIM(REGEXP_REPLACE(val, '\s+', ' ', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Recalcular índices que dependem de normalized_sku
UPDATE public.products
SET normalized_sku = public.normalize_sku(sku)
WHERE sku IS NOT NULL;

UPDATE public.product_variants
SET normalized_sku = public.normalize_sku(sku)
WHERE sku IS NOT NULL;
