-- =====================================================================
-- Diagnóstico multi-conta ML + multi-CNPJ (DEV)
-- Rode no SQL Editor do Supabase após conectar 2+ contas.
-- =====================================================================

SELECT
  id,
  user_id,
  company_name,
  trade_name,
  document_cnpj,
  is_default,
  created_at
FROM seller_companies
ORDER BY created_at;

SELECT
  id,
  user_id,
  seller_company_id,
  marketplace,
  external_seller_id,
  account_alias,
  ml_nickname,
  connection_health,
  token_expires_at,
  created_at,
  updated_at
FROM marketplace_accounts
WHERE marketplace = 'mercado_livre'
ORDER BY created_at;

SELECT
  id,
  user_id,
  marketplace,
  ml_user_id,
  ml_nickname,
  created_at,
  updated_at
FROM ml_tokens
WHERE marketplace = 'mercado_livre'
ORDER BY updated_at DESC;

-- Alinhamento conta ↔ token (external_seller_id deve bater com ml_user_id na linha de token)
SELECT
  ma.id AS marketplace_account_id,
  ma.user_id,
  ma.external_seller_id::text AS account_external_seller_id,
  t.id AS ml_token_id,
  t.ml_user_id::text AS token_ml_user_id,
  (ma.external_seller_id::text IS NOT DISTINCT FROM t.ml_user_id::text) AS aligned
FROM marketplace_accounts ma
LEFT JOIN ml_tokens t
  ON t.user_id = ma.user_id
 AND t.marketplace = ma.marketplace
 AND t.ml_user_id::text = ma.external_seller_id::text
WHERE ma.marketplace = 'mercado_livre'
ORDER BY ma.created_at;

SELECT
  id,
  marketplace_account_id,
  seller_company_id,
  job_type,
  status,
  progress_current,
  progress_total,
  left(coalesce(error_message, ''), 120) AS error_message_preview,
  created_at,
  updated_at
FROM marketplace_account_sync_jobs
ORDER BY created_at DESC
LIMIT 200;

-- Anti-padrão: mais de uma linha ml_tokens para o mesmo par user+marketplace
-- com ml_user_id distintos = OK após migration multi-conta.
-- Uma linha só com ml_user_id mudando entre OAuth = sintoma de upsert legado.
SELECT user_id, marketplace, count(*) AS n
FROM ml_tokens
GROUP BY 1, 2
ORDER BY n DESC;
