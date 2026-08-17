-- ======================================================================
-- Diagnóstico: alinhamento marketplace_accounts ↔ ml_tokens (Mercado Livre)
-- Rode no SQL Editor do Supabase (ou psql). Somente leitura.
-- ======================================================================

-- 1) Contas ML
SELECT
  id,
  user_id,
  seller_company_id,
  marketplace,
  external_seller_id,
  ml_nickname,
  account_alias,
  status,
  created_at,
  updated_at
FROM marketplace_accounts
WHERE marketplace IN ('mercado_livre', 'mercadolivre')
ORDER BY user_id, created_at;

-- 2) Tokens ML
SELECT
  id,
  user_id,
  ml_user_id,
  marketplace_account_id,
  seller_company_id,
  expires_at,
  created_at,
  updated_at
FROM ml_tokens
ORDER BY user_id, updated_at DESC;

-- 3) Desalinhamento (LEFT JOIN por user_id + ml_user_id = external_seller_id)
SELECT
  ma.id AS marketplace_account_id,
  ma.user_id,
  ma.seller_company_id AS account_seller_company_id,
  ma.external_seller_id,
  mt.ml_user_id,
  mt.marketplace_account_id AS token_marketplace_account_id,
  mt.seller_company_id AS token_seller_company_id,
  CASE
    WHEN mt.ml_user_id IS NULL THEN false
    WHEN mt.ml_user_id::text = ma.external_seller_id::text THEN true
    ELSE false
  END AS token_matches_account
FROM marketplace_accounts ma
LEFT JOIN ml_tokens mt
  ON mt.user_id = ma.user_id
 AND mt.ml_user_id::text = ma.external_seller_id::text
WHERE ma.marketplace IN ('mercado_livre', 'mercadolivre');

-- 4) Tokens órfãos (sem marketplace_account com mesmo external_seller_id)
SELECT
  mt.*
FROM ml_tokens mt
LEFT JOIN marketplace_accounts ma
  ON ma.user_id = mt.user_id
 AND ma.external_seller_id::text = mt.ml_user_id::text
WHERE ma.id IS NULL;
