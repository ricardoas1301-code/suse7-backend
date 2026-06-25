-- ======================================================================
-- Diagnóstico: gap entre ml_tokens e marketplace_accounts (OAuth ML)
-- Rode no SQL Editor (Supabase DEV/PROD).
-- ======================================================================

-- Últimos tokens ML
SELECT id, user_id, marketplace, ml_user_id, ml_nickname, expires_at, updated_at
FROM public.ml_tokens
WHERE marketplace = 'mercado_livre'
ORDER BY updated_at DESC
LIMIT 20;

-- Contas marketplace por usuário que tem token mas sem conta (anti-join)
SELECT
  t.user_id,
  COUNT(t.id) AS ml_token_rows,
  COUNT(m.id) AS marketplace_account_rows
FROM public.ml_tokens t
LEFT JOIN public.marketplace_accounts m
  ON m.user_id = t.user_id AND m.marketplace = t.marketplace
WHERE t.marketplace = 'mercado_livre'
GROUP BY t.user_id
HAVING COUNT(m.id) = 0 AND COUNT(t.id) > 0
ORDER BY MAX(t.updated_at) DESC
LIMIT 50;

-- Empresas do vendedor (FK comum em marketplace_accounts)
SELECT id, user_id, name, created_at
FROM public.seller_companies
ORDER BY created_at DESC
LIMIT 30;

-- Últimas contas marketplace
SELECT id, user_id, seller_company_id, marketplace, external_seller_id, status, created_at, updated_at
FROM public.marketplace_accounts
WHERE marketplace = 'mercado_livre'
ORDER BY created_at DESC
LIMIT 30;
