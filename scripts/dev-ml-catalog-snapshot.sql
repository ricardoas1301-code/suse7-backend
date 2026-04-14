-- =====================================================================
-- SNAPSHOT PRÉ-RESET — catálogo Mercado Livre (somente leitura)
-- =====================================================================
-- Execute apenas no projeto Supabase DEV (confira o project ref no URL).
--
-- Para um único utilizador em DEV partilhado, descomente o filtro user_id
-- em todos os CTEs marcados com -- [optional user filter]
-- =====================================================================

WITH
ml AS (
  SELECT *
  FROM public.marketplace_listings ml
  WHERE ml.marketplace IN ('mercado_livre', 'mercadolivre')
  -- [optional user filter] AND ml.user_id = '00000000-0000-0000-0000-000000000001'::uuid
),
pic_urls AS (
  SELECT
    mlp.listing_id,
    bool_or(
      (
        mlp.secure_url IS NOT NULL
        AND btrim(mlp.secure_url) <> ''
        AND (
          lower(btrim(mlp.secure_url)) LIKE 'http://%'
          OR lower(btrim(mlp.secure_url)) LIKE 'https://%'
          OR btrim(mlp.secure_url) LIKE '//%'
        )
      )
      OR (
        mlp.url IS NOT NULL
        AND btrim(mlp.url) <> ''
        AND (
          lower(btrim(mlp.url)) LIKE 'http://%'
          OR lower(btrim(mlp.url)) LIKE 'https://%'
          OR btrim(mlp.url) LIKE '//%'
        )
      )
    ) AS has_http
  FROM public.marketplace_listing_pictures mlp
  GROUP BY mlp.listing_id
),
raw_cover AS (
  SELECT
    ml.id,
    (
      COALESCE(ml.raw_json->'pictures'->0->>'secure_url', '') <> ''
      OR COALESCE(ml.raw_json->'pictures'->0->>'url', '') <> ''
      OR COALESCE(ml.raw_json->>'thumbnail', '') <> ''
    )
    AND (
      lower(COALESCE(ml.raw_json->'pictures'->0->>'secure_url', 'x')) LIKE 'http://%'
      OR lower(COALESCE(ml.raw_json->'pictures'->0->>'secure_url', 'x')) LIKE 'https://%'
      OR COALESCE(ml.raw_json->'pictures'->0->>'secure_url', '') LIKE '//%'
      OR lower(COALESCE(ml.raw_json->'pictures'->0->>'url', 'x')) LIKE 'http://%'
      OR lower(COALESCE(ml.raw_json->'pictures'->0->>'url', 'x')) LIKE 'https://%'
      OR COALESCE(ml.raw_json->'pictures'->0->>'url', '') LIKE '//%'
      OR lower(COALESCE(ml.raw_json->>'thumbnail', 'x')) LIKE 'http://%'
      OR lower(COALESCE(ml.raw_json->>'thumbnail', 'x')) LIKE 'https://%'
      OR COALESCE(ml.raw_json->>'thumbnail', '') LIKE '//%'
    ) AS raw_has_http
  FROM ml
),
product_cover AS (
  SELECT
    ml.id,
    EXISTS (
      SELECT 1
      FROM public.products pr
      WHERE pr.id = ml.product_id
        AND pr.user_id = ml.user_id
        AND jsonb_typeof(pr.product_images) = 'array'
        AND jsonb_array_length(pr.product_images) > 0
        AND COALESCE(pr.product_images->0->>'url', '') <> ''
    ) AS prod_img
  FROM ml
)
SELECT
  (SELECT count(*) FROM ml) AS marketplace_listings_ml,
  (SELECT count(*) FROM public.marketplace_listing_pictures mlp WHERE EXISTS (SELECT 1 FROM ml WHERE ml.id = mlp.listing_id))
    AS marketplace_listing_pictures_rows,
  (SELECT count(*) FROM public.marketplace_listing_health h WHERE h.marketplace IN ('mercado_livre', 'mercadolivre'))
    AS marketplace_listing_health_rows,
  (SELECT count(*) FROM public.listing_sales_metrics m WHERE m.marketplace IN ('mercado_livre', 'mercadolivre'))
    AS listing_sales_metrics_rows,
  (SELECT count(*) FROM public.marketplace_listing_change_events e WHERE EXISTS (SELECT 1 FROM ml WHERE ml.id = e.listing_id))
    AS listing_change_events_rows,
  (SELECT count(*) FROM ml WHERE ml.product_id IS NOT NULL) AS listings_with_product_id,
  (
    SELECT count(*) FROM ml
    WHERE
      (ml.seller_sku IS NOT NULL AND btrim(ml.seller_sku) <> '')
      OR (ml.seller_custom_field IS NOT NULL AND btrim(ml.seller_custom_field) <> '')
  ) AS listings_sku_columns_non_empty,
  (
    SELECT count(*) FROM ml
    LEFT JOIN pic_urls pu ON pu.listing_id = ml.id
    LEFT JOIN raw_cover rc ON rc.id = ml.id
    LEFT JOIN product_cover pc ON pc.id = ml.id
    WHERE COALESCE(rc.raw_has_http, false)
      OR COALESCE(pu.has_http, false)
      OR COALESCE(pc.prod_img, false)
  ) AS listings_likely_cover_resolved,
  now() AS snapped_at;
