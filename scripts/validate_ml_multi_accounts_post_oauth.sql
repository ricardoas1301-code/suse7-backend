-- Validação pós-OAuth: 2+ contas ML — marketplace_accounts, seller_companies, ml_tokens alinhados.
-- Rode no SQL Editor do Supabase após conectar conta 1 e conta 2 (substitua :user_id pelo UUID do perfil).

-- SELECT
--   ma.id,
--   ma.user_id,
--   ma.seller_company_id,
--   sc.company_name,
--   ma.external_seller_id,
--   ma.ml_nickname,
--   mt.id AS token_id,
--   mt.ml_user_id,
--   mt.marketplace_account_id,
--   (ma.external_seller_id::text = mt.ml_user_id::text) AS aligned
-- FROM marketplace_accounts ma
-- LEFT JOIN seller_companies sc ON sc.id = ma.seller_company_id
-- LEFT JOIN ml_tokens mt ON mt.marketplace_account_id = ma.id
-- WHERE ma.user_id = :user_id
--   AND ma.marketplace = 'mercado_livre'
--   AND ma.status <> 'removed'
-- ORDER BY ma.created_at;

SELECT
  ma.id,
  ma.user_id,
  ma.seller_company_id,
  sc.company_name,
  ma.external_seller_id,
  ma.ml_nickname AS nickname,
  mt.id AS token_id,
  mt.ml_user_id,
  mt.marketplace_account_id,
  (ma.external_seller_id::text = mt.ml_user_id::text) AS aligned
FROM marketplace_accounts ma
LEFT JOIN seller_companies sc ON sc.id = ma.seller_company_id
LEFT JOIN ml_tokens mt ON mt.marketplace_account_id = ma.id
WHERE ma.marketplace = 'mercado_livre'
  AND ma.status <> 'removed'
ORDER BY ma.created_at;
