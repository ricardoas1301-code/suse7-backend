-- ======================================================================
-- products.product_images: text -> jsonb
-- Formato canônico: [{ "url": "https://..." }] ou NULL
-- ======================================================================

ALTER TABLE public.products
ALTER COLUMN product_images TYPE jsonb
USING (
  CASE
    WHEN product_images IS NULL THEN NULL::jsonb
    WHEN trim(product_images::text) = '' THEN NULL::jsonb
    WHEN trim(product_images::text) ~ '^https?://' THEN jsonb_build_array(
      jsonb_build_object('url', trim(product_images::text))
    )
    ELSE NULLIF(trim(product_images::text), '')::jsonb
  END
);

COMMENT ON COLUMN public.products.product_images IS 'Miniaturas/listagem: array JSON [{ "url": "https://..." }]';
