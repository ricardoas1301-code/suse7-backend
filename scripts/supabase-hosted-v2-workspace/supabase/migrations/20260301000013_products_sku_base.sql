-- ======================================================================
-- products.sku_base: raiz literal do SKU para geração consistente de SKUs
-- em variações (não duplicar em product_variants). Preserva texto do usuário.
-- ======================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sku_base text NULL;

COMMENT ON COLUMN public.products.sku_base IS
  'Raiz do SKU (formato variants): base comum para gerar SKUs das variações; literal como digitado.';

-- Produtos antigos: preencher a partir do SKU pai quando fizer sentido
UPDATE public.products
SET sku_base = sku
WHERE lower(coalesce(format, '')) = 'variants'
  AND sku IS NOT NULL
  AND btrim(sku) <> ''
  AND (sku_base IS NULL OR btrim(sku_base) = '');
