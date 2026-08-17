-- ======================================================================
-- DIAGNÓSTICO + BACKFILL SEGURO (UPDATE comentado) — seller_company_id em marketplace_accounts
-- Mercado Livre no código: slug principal `mercado_livre` (ver mlMarketplace.js). Pode existir legado `mercadolivre`.
-- Rodar primeiro em DEV/staging. Não aplicar UPDATE sem revisar os SELECTs e backup.
-- ======================================================================

-- --- 1) Contas Mercado Livre sem seller_company_id (somente leitura)
SELECT
  id,
  user_id,
  marketplace,
  external_seller_id,
  ml_nickname,
  account_alias,
  status,
  seller_company_id,
  created_at,
  updated_at
FROM public.marketplace_accounts
WHERE marketplace IN ('mercado_livre', 'mercadolivre')
  AND seller_company_id IS NULL
ORDER BY created_at;

-- --- 2) Empresas cadastradas por usuário (somente leitura)
SELECT
  sc.user_id,
  COUNT(*) AS total_companies
FROM public.seller_companies sc
GROUP BY sc.user_id
ORDER BY total_companies DESC;

-- --- 3) Candidatos seguros para backfill manual/automatizado:
--     conta ML sem seller_company_id E usuário com exatamente 1 seller_company (somente leitura)
SELECT
  ma.id AS marketplace_account_id,
  ma.user_id,
  ma.marketplace,
  ma.external_seller_id,
  ma.status,
  sc.id AS sole_seller_company_id,
  sc.trade_name,
  sc.company_name
FROM public.marketplace_accounts ma
INNER JOIN public.seller_companies sc ON sc.user_id = ma.user_id
WHERE ma.marketplace IN ('mercado_livre', 'mercadolivre')
  AND ma.seller_company_id IS NULL
  AND ma.status IS DISTINCT FROM 'removed'
  AND (SELECT COUNT(*)::int FROM public.seller_companies sc2 WHERE sc2.user_id = ma.user_id) = 1;

-- --- 4) Usuários com mais de uma empresa: NÃO fazer backfill automático; revisar manualmente
SELECT
  ma.id AS marketplace_account_id,
  ma.user_id,
  ma.external_seller_id,
  (SELECT COUNT(*)::int FROM public.seller_companies sc WHERE sc.user_id = ma.user_id) AS total_companies
FROM public.marketplace_accounts ma
WHERE ma.marketplace IN ('mercado_livre', 'mercadolivre')
  AND ma.seller_company_id IS NULL
  AND ma.status IS DISTINCT FROM 'removed'
  AND (SELECT COUNT(*)::int FROM public.seller_companies sc WHERE sc.user_id = ma.user_id) > 1;

-- ======================================================================
-- 5) UPDATE — MANTIDO COMENTADO. Descomente só após validar seções 1–4 e backup.
-- Preenche seller_company_id apenas quando:
--   - seller_company_id IS NULL na conta
--   - marketplace ML (slug acima)
--   - status diferente de removed
--   - usuário possui exatamente 1 seller_company (CTE `sole`)
--   - não existe outra conta ML ativa já usando essa empresa para o mesmo user
-- ======================================================================
-- WITH sole AS (
--   SELECT user_id, MIN(id) AS company_id
--   FROM public.seller_companies
--   GROUP BY user_id
--   HAVING COUNT(*) = 1
-- )
-- UPDATE public.marketplace_accounts ma
-- SET seller_company_id = sole.company_id, updated_at = NOW()
-- FROM sole
-- WHERE sole.user_id = ma.user_id
--   AND ma.marketplace IN ('mercado_livre', 'mercadolivre')
--   AND ma.seller_company_id IS NULL
--   AND ma.status IS DISTINCT FROM 'removed'
--   AND NOT EXISTS (
--     SELECT 1 FROM public.marketplace_accounts o
--     WHERE o.user_id = ma.user_id AND o.id <> ma.id
--       AND o.marketplace IN ('mercado_livre', 'mercadolivre')
--       AND o.seller_company_id = sole.company_id
--       AND o.status IS DISTINCT FROM 'removed'
--   );
