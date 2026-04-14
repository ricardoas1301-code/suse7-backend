-- Auditoria de capa: substituir todos os '00000000-0000-0000-0000-000000000000'
-- pelo UUID real (marketplace_listings.id). Rodar no SQL Editor do Supabase.

-- 1) Anúncio
SELECT id,
       user_id,
       marketplace,
       external_listing_id,
       title,
       product_id,
       pictures_count,
       (raw_json -> 'pictures') AS raw_pictures_head,
       (raw_json ->> 'thumbnail') AS raw_thumbnail,
       (jsonb_array_length(COALESCE(raw_json -> 'pictures', '[]'::jsonb))) AS raw_pictures_len
FROM marketplace_listings
WHERE id = '00000000-0000-0000-0000-000000000000';

-- 2) Fotos persistidas
SELECT listing_id,
       position,
       secure_url,
       url,
       external_picture_id
FROM marketplace_listing_pictures
WHERE listing_id = '00000000-0000-0000-0000-000000000000'
ORDER BY position ASC;

-- 3) Produto + links (se product_id preenchido)
SELECT p.id,
       p.product_images
FROM marketplace_listings ml
JOIN products p ON p.id = ml.product_id
WHERE ml.id = '00000000-0000-0000-0000-000000000000';

SELECT l.id,
       l.product_id,
       l.position,
       l.url,
       l.public_url,
       l.listing_id
FROM marketplace_listings ml
JOIN product_image_links l ON l.product_id = ml.product_id
WHERE ml.id = '00000000-0000-0000-0000-000000000000'
ORDER BY l.position ASC;
