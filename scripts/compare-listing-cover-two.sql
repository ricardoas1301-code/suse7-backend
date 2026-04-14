-- =====================================================================
-- Comparar 2 anúncios ML — capa / raw_json / tabela de fotos
-- =====================================================================
-- Substitui os dois IDs abaixo (sem aspas a mais). Rode no SQL Editor DEV.
-- "Sem imagem" vs "com imagem" na grid — compara onde divergem os dados.
-- =====================================================================

WITH
targets(label, external_listing_id) AS (
  VALUES
    ('SEM_IMAGEM_NA_GRID', 'MLB0000000000'), -- troque pelo external_id real (ex.: MLB4065122155)
    ('COM_IMAGEM_NA_GRID', 'MLB0000000001')  -- troque pelo external_id real
),
ml AS (
  SELECT
    t.label,
    ml.id AS listing_id,
    ml.user_id,
    ml.external_listing_id,
    ml.pictures_count,
    ml.raw_json,
    jsonb_typeof(ml.raw_json->'pictures') AS raw_pictures_type,
    CASE
      WHEN jsonb_typeof(ml.raw_json->'pictures') = 'array' THEN jsonb_array_length(ml.raw_json->'pictures')
      ELSE NULL
    END AS raw_pictures_len,
    left(ml.raw_json->'pictures'->0->>'secure_url', 120) AS raw_p0_secure_url_sample,
    left(ml.raw_json->'pictures'->0->>'url', 120) AS raw_p0_url_sample,
    left(ml.raw_json->>'thumbnail', 120) AS raw_thumbnail_sample
  FROM targets t
  JOIN public.marketplace_listings ml
    ON ml.external_listing_id = t.external_listing_id
   AND ml.marketplace IN ('mercado_livre', 'mercadolivre')
),
pics AS (
  SELECT
    t.label,
    ml.id AS listing_id,
    count(mlp.id)::bigint AS db_picture_rows,
    bool_or(
      mlp.secure_url IS NOT NULL AND btrim(mlp.secure_url) <> ''
      AND (
        lower(btrim(mlp.secure_url)) LIKE 'http%'
        OR btrim(mlp.secure_url) LIKE '//%'
      )
    ) AS db_has_any_secure_http,
    bool_or(
      mlp.url IS NOT NULL AND btrim(mlp.url) <> ''
      AND (
        lower(btrim(mlp.url)) LIKE 'http%'
        OR btrim(mlp.url) LIKE '//%'
      )
    ) AS db_has_any_url_http
  FROM targets t
  JOIN public.marketplace_listings ml
    ON ml.external_listing_id = t.external_listing_id
   AND ml.marketplace IN ('mercado_livre', 'mercadolivre')
  LEFT JOIN public.marketplace_listing_pictures mlp ON mlp.listing_id = ml.id
  GROUP BY t.label, ml.id
),
first_pic AS (
  SELECT DISTINCT ON (mlp.listing_id)
    mlp.listing_id,
    mlp.position,
    left(mlp.secure_url, 120) AS first_secure_url_sample,
    left(mlp.url, 120) AS first_url_sample
  FROM public.marketplace_listing_pictures mlp
  ORDER BY mlp.listing_id, mlp.position ASC NULLS LAST, mlp.id ASC
)
SELECT
  ml.label AS caso,
  ml.external_listing_id,
  ml.listing_id,
  ml.pictures_count,
  ml.raw_pictures_len,
  ml.raw_p0_secure_url_sample,
  ml.raw_p0_url_sample,
  ml.raw_thumbnail_sample,
  coalesce(p.db_picture_rows, 0) AS marketplace_listing_pictures_rows,
  coalesce(p.db_has_any_secure_http, false) AS db_algum_secure_http,
  coalesce(p.db_has_any_url_http, false) AS db_algum_url_http,
  fp.first_secure_url_sample,
  fp.first_url_sample
FROM ml
LEFT JOIN pics p ON p.label = ml.label AND p.listing_id = ml.listing_id
LEFT JOIN first_pic fp ON fp.listing_id = ml.listing_id
ORDER BY ml.label;
