-- ======================================================================
-- Snapshot pós-falha OAuth / multi-conta ML — substitua <USER_ID> pelo UUID.
-- Rode no SQL Editor do Supabase (ou psql) logo após reproduzir o bug.
-- ======================================================================

-- 1) Contas marketplace (esperado: uma linha por conta ML conectada)
SELECT
  id,
  user_id,
  marketplace,
  external_seller_id,
  seller_company_id,
  status,
  created_at,
  updated_at
FROM marketplace_accounts
WHERE user_id = '<USER_ID>'
ORDER BY created_at;

-- 2) Tokens ML (esperado: uma linha por ml_user_id; marketplace_account_id alinhado à conta)
SELECT
  id,
  user_id,
  marketplace,
  ml_user_id,
  marketplace_account_id,
  created_at,
  updated_at
FROM ml_tokens
WHERE user_id = '<USER_ID>'
ORDER BY created_at;
