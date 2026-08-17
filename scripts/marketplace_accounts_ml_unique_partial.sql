-- ======================================================================
-- Índices únicos parciais — marketplace_accounts (ML / multi-marketplace)
-- Objetivo: 1) no máximo uma conta ativa por (user, marketplace, seller_company_id)
--           2) no máximo uma conta ativa por (user, marketplace, external_seller_id)
--
-- ANTES DE CRIAR ÍNDICE:
--   1) Rode os SELECTs de diagnóstico abaixo (status distintos + duplicidades).
--   2) Ajuste o predicado WHERE do índice ao enum REAL de `status` (ex.: removed, inactive).
--   3) Se qualquer query de duplicidade retornar linhas, corrija dados antes do CREATE INDEX.
-- Não execute CREATE INDEX comentado até concluir os passos acima.
-- Slug ML no app: `mercado_livre`; pode existir legado `mercadolivre` — inclua ambos nos diagnósticos.
-- ======================================================================

-- --- Status distintos em marketplace_accounts (somente leitura)
SELECT DISTINCT status
FROM public.marketplace_accounts
ORDER BY 1;

-- --- Duplicidade ativa: mesmo user + marketplace + seller_company_id (exclui removed)
SELECT
  user_id,
  marketplace,
  seller_company_id,
  COUNT(*) AS total
FROM public.marketplace_accounts
WHERE marketplace IN ('mercado_livre', 'mercadolivre')
  AND seller_company_id IS NOT NULL
  AND status IS DISTINCT FROM 'removed'
GROUP BY user_id, marketplace, seller_company_id
HAVING COUNT(*) > 1;

-- --- Duplicidade ativa: mesmo user + marketplace + external_seller_id (exclui removed)
SELECT
  user_id,
  marketplace,
  external_seller_id,
  COUNT(*) AS total
FROM public.marketplace_accounts
WHERE marketplace IN ('mercado_livre', 'mercadolivre')
  AND external_seller_id IS NOT NULL
  AND external_seller_id <> ''
  AND status IS DISTINCT FROM 'removed'
GROUP BY user_id, marketplace, external_seller_id
HAVING COUNT(*) > 1;

-- ======================================================================
-- CREATE UNIQUE INDEX — MANTIDO COMENTADO até validar WHERE + ausência de duplicatas
-- ======================================================================

-- CREATE UNIQUE INDEX IF NOT EXISTS marketplace_accounts_user_mp_company_active_uidx
-- ON public.marketplace_accounts (user_id, marketplace, seller_company_id)
-- WHERE status IS DISTINCT FROM 'removed' AND seller_company_id IS NOT NULL;

-- CREATE UNIQUE INDEX IF NOT EXISTS marketplace_accounts_user_mp_ext_active_uidx
-- ON public.marketplace_accounts (user_id, marketplace, external_seller_id)
-- WHERE status IS DISTINCT FROM 'removed' AND external_seller_id IS NOT NULL;
