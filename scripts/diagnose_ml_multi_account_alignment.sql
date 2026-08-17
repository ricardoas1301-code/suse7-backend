-- S7 — após 2ª conexão ML: provar se existem 2 marketplace_accounts + tokens alinhados por conta.
SELECT
  ma.id,
  ma.seller_company_id,
  ma.external_seller_id,
  ma.nickname,
  ma.account_name,
  mt.ml_user_id,
  mt.marketplace_account_id,
  (ma.external_seller_id::text = mt.ml_user_id::text) AS aligned
FROM marketplace_accounts ma
LEFT JOIN ml_tokens mt
  ON mt.marketplace_account_id = ma.id
ORDER BY ma.created_at;
