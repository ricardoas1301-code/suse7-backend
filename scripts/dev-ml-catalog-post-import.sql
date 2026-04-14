-- =====================================================================
-- PÓS-IMPORTAÇÃO — contagens para validar CAPA e catálogo (DEV)
-- =====================================================================
-- Corre **depois** de: reset + POST /api/ml/sync-listings (+ opcional sync-sales
-- para repovoar listing_sales_metrics).
--
-- Item 6 (inconsistências): usa flags no resultado; revisa manualmente.
-- =====================================================================

WITH
ml AS (
  SELECT *
  FROM public.marketplace_listings
  WHERE marketplace IN ('mercado_livre', 'mercadolivre')
),
first_pic AS (
  SELECT DISTINCT ON (listing_id)
    listing_id,
    secure_url,
    url,
    position
  FROM public.marketplace_listing_pictures
  ORDER BY listing_id, position ASC NULLS LAST, id ASC
),
pic_any AS (
  SELECT listing_id, count(*) AS n
  FROM public.marketplace_listing_pictures
  GROUP BY listing_id
)
SELECT
  'post_import_summary'::text AS report,
  (SELECT count(*) FROM ml) AS total_anuncios_importados,
  (SELECT coalesce(sum(n), 0)::bigint FROM pic_any pa WHERE EXISTS (SELECT 1 FROM ml WHERE ml.id = pa.listing_id))
    AS total_linhas_imagens,
  (
    SELECT count(*) FROM ml
    WHERE EXISTS (
      SELECT 1 FROM first_pic fp
      WHERE fp.listing_id = ml.id
        AND (
          (fp.secure_url IS NOT NULL AND btrim(fp.secure_url) <> '')
          OR (fp.url IS NOT NULL AND btrim(fp.url) <> '')
        )
        AND (
          lower(btrim(coalesce(fp.secure_url, ''))) LIKE 'http%'
          OR lower(btrim(coalesce(fp.url, ''))) LIKE 'http%'
          OR btrim(coalesce(fp.secure_url, fp.url, '')) LIKE '//%'
        )
    )
  ) AS anuncios_primeira_foto_com_url_http,
  (
    SELECT count(*) FROM ml
    WHERE
      (ml.seller_sku IS NOT NULL AND btrim(ml.seller_sku) <> '')
      OR (ml.seller_custom_field IS NOT NULL AND btrim(ml.seller_custom_field) <> '')
  ) AS anuncios_sku_colunas,
  (
    SELECT count(*) FROM ml
    WHERE ml.pictures_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM marketplace_listing_pictures p
        WHERE p.listing_id = ml.id
          AND (
            (p.secure_url IS NOT NULL AND btrim(p.secure_url) <> '')
            OR (p.url IS NOT NULL AND btrim(p.url) <> '')
          )
      )
  ) AS flag_inconsist_pictures_count_sem_linhas_foto,
  (
    SELECT count(*) FROM ml
    WHERE ml.pictures_count > 0
      AND NOT EXISTS (
        SELECT 1 FROM marketplace_listing_pictures p
        WHERE p.listing_id = ml.id
          AND (
            (p.secure_url IS NOT NULL AND btrim(p.secure_url) <> '' AND (
              lower(btrim(p.secure_url)) LIKE 'http://%'
              OR lower(btrim(p.secure_url)) LIKE 'https://%'
              OR btrim(p.secure_url) LIKE '//%'
            ))
            OR (p.url IS NOT NULL AND btrim(p.url) <> '' AND (
              lower(btrim(p.url)) LIKE 'http://%'
              OR lower(btrim(p.url)) LIKE 'https://%'
              OR btrim(p.url) LIKE '//%'
            ))
          )
      )
  ) AS flag_inconsist_sem_url_http_em_fotos,
  now() AS checked_at;
