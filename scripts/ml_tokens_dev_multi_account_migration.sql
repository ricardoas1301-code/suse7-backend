-- ======================================================================
-- SUSE7 — DEV: ml_tokens multi-conta Mercado Livre (script completo)
--
-- Objetivo:
--   1) Inspecionar constraints e índices atuais de public.ml_tokens
--   2) Detectar duplicidades por (user_id, marketplace, ml_user_id)
--   3) Detectar UNIQUE / índice único legado só (user_id, marketplace)
--   4) Gerar comandos seguros para remover o legado (você revisa e cola)
--   5) Criar índice único correto (user_id, marketplace, ml_user_id)
--   6) Diagnóstico de desalinhamento ml_tokens ↔ marketplace_accounts
--
-- REGRAS:
--   - Nada aqui apaga ou atualiza dados automaticamente.
--   - Só CREATE INDEX / DROP INDEX / DROP CONSTRAINT após você validar os SELECTs.
--   - Rode no SQL Editor do Supabase (public). Faça backup se houver dúvida.
--
-- ORDEM RECOMENDADA:
--   A → B → C → D → E3 (contadores legado) → E / E2 (copiar e executar DROPs manualmente) →
--   rodar de novo A–E3 → F (bloco DO; falha se ainda houver lixo) → G → H
--   J só se precisar limpar dados em DEV (descomentar com cuidado).
-- ======================================================================

SET search_path TO public;

-- ======================================================================
-- A) Índices em public.ml_tokens (definição completa — copiável)
-- ======================================================================
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'ml_tokens'
ORDER BY indexname;

-- ======================================================================
-- B) Constraints de tabela em public.ml_tokens (PK, UNIQUE, CHECK, FK…)
-- ======================================================================
SELECT
  c.conname AS constraint_name,
  c.contype AS constraint_type,
  pg_get_constraintdef(c.oid) AS constraint_definition
FROM pg_constraint AS c
JOIN pg_class AS rel ON rel.oid = c.conrelid
JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
WHERE ns.nspname = 'public'
  AND rel.relname = 'ml_tokens'
ORDER BY c.contype, c.conname;

-- ======================================================================
-- C) Duplicidade TRIPLA — bloqueia CREATE UNIQUE INDEX (user_id, marketplace, ml_user_id)
--     Se retornar linhas: corrija dados ANTES do passo F (use bloco J opcional).
-- ======================================================================
SELECT
  user_id,
  marketplace,
  ml_user_id,
  COUNT(*) AS row_count,
  array_agg(id ORDER BY id DESC) AS ml_token_ids_newest_first
FROM public.ml_tokens
GROUP BY user_id, marketplace, ml_user_id
HAVING COUNT(*) > 1
ORDER BY row_count DESC, user_id, marketplace, ml_user_id;

-- ======================================================================
-- D) Conflito do modelo MONO — mesmo (user_id, marketplace), ml_user_id diferentes
--     Indica sobrescrita legada ou import duplicado; exige limpeza antes do índice triplo.
-- ======================================================================
SELECT
  user_id,
  marketplace,
  COUNT(DISTINCT ml_user_id) AS distinct_ml_user_ids,
  COUNT(*) AS total_rows,
  array_agg(DISTINCT ml_user_id::text ORDER BY ml_user_id::text) AS ml_user_ids
FROM public.ml_tokens
GROUP BY user_id, marketplace
HAVING COUNT(*) > 1 OR COUNT(DISTINCT ml_user_id) > 1
ORDER BY total_rows DESC, user_id, marketplace;

-- ======================================================================
-- E) UNIQUE legado em CONSTRAINT — só (user_id, marketplace), sem ml_user_id
--     Saída: DDL sugerido (revise o nome e a definição antes de executar).
-- ======================================================================
WITH uq AS (
  SELECT
    c.conname,
    c.oid,
    array_agg(a.attname ORDER BY u.ordinality) AS col_names
  FROM pg_constraint AS c
  JOIN pg_class AS rel ON rel.oid = c.conrelid
  JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ordinality)
  JOIN pg_attribute AS a
    ON a.attrelid = c.conrelid
   AND a.attnum = u.attnum
   AND NOT a.attisdropped
  WHERE ns.nspname = 'public'
    AND rel.relname = 'ml_tokens'
    AND c.contype = 'u'
  GROUP BY c.conname, c.oid, c.conrelid
)
SELECT
  conname AS legacy_unique_constraint_name,
  col_names,
  'ALTER TABLE public.ml_tokens DROP CONSTRAINT IF EXISTS ' || quote_ident(conname) || ';' AS suggested_drop_sql
FROM uq
WHERE
  col_names IN (
    ARRAY['user_id', 'marketplace']::name[],
    ARRAY['marketplace', 'user_id']::name[]
  );

-- ======================================================================
-- E2) UNIQUE legado como INDEX (sem constraint nomeada na tabela)
--      Heurística: CREATE UNIQUE INDEX … (user_id, marketplace) sem ml_user_id na lista de colunas.
--      Revise indexdef na coluna indexdef antes de dropar.
-- ======================================================================
SELECT
  indexname,
  indexdef,
  'DROP INDEX IF EXISTS public.' || quote_ident(indexname) || ';' AS suggested_drop_sql
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'ml_tokens'
  AND indexdef ~* '^CREATE UNIQUE INDEX'
  AND (
    (indexdef LIKE '%(user_id, marketplace)%' OR indexdef LIKE '%(marketplace, user_id)%')
    AND indexdef NOT LIKE '%ml_user_id%'
  )
  -- não remover o índice novo se já existir com outro nome mas mesma ideia:
  AND indexname IS DISTINCT FROM 'ml_tokens_user_marketplace_ml_user_uidx';

-- ======================================================================
-- E3) Resumo numérico — legado mono-conta ainda presente? (0 = ok para criar índice triplo)
-- ======================================================================
WITH uq AS (
  SELECT
    c.conname,
    array_agg(a.attname ORDER BY u.ordinality) AS col_names
  FROM pg_constraint AS c
  JOIN pg_class AS rel ON rel.oid = c.conrelid
  JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ordinality)
  JOIN pg_attribute AS a
    ON a.attrelid = c.conrelid
   AND a.attnum = u.attnum
   AND NOT a.attisdropped
  WHERE ns.nspname = 'public'
    AND rel.relname = 'ml_tokens'
    AND c.contype = 'u'
  GROUP BY c.conname, c.conrelid
)
SELECT
  (SELECT COUNT(*) FROM uq
   WHERE col_names IN (
     ARRAY['user_id', 'marketplace']::name[],
     ARRAY['marketplace', 'user_id']::name[]
   )) AS legacy_unique_constraint_count,
  (SELECT COUNT(*)::bigint
   FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'ml_tokens'
     AND indexdef ~* '^CREATE UNIQUE INDEX'
     AND (
       (indexdef LIKE '%(user_id, marketplace)%' OR indexdef LIKE '%(marketplace, user_id)%')
       AND indexdef NOT LIKE '%ml_user_id%'
     )
     AND indexname IS DISTINCT FROM 'ml_tokens_user_marketplace_ml_user_uidx'
  ) AS legacy_unique_index_count;

-- ======================================================================
-- F) Criar índice único CORRETO (multi-conta) — EXECUÇÃO GUARDADA
--
--     Este bloco só roda o CREATE se:
--       - Não houver duplicata tripla (passo C vazio)
--       - Não houver conflito mono (passo D vazio)
--       - Não restar UNIQUE legado só (user_id, marketplace) em constraint nem em índice (E3 = 0)
--
--     Se o bloco levantar EXCEPTION, leia a mensagem, rode os DROPs de E/E2 ou limpeza J, e tente de novo.
-- ======================================================================
DO $migration$
DECLARE
  n_triple_dup integer;
  n_mono_conflict integer;
  n_legacy_uq integer;
  n_legacy_idx integer;
BEGIN
  SELECT COUNT(*)::integer
  INTO n_triple_dup
  FROM (
    SELECT 1
    FROM public.ml_tokens
    GROUP BY user_id, marketplace, ml_user_id
    HAVING COUNT(*) > 1
  ) AS triple_dups;

  SELECT COUNT(*)::integer
  INTO n_mono_conflict
  FROM (
    SELECT 1
    FROM public.ml_tokens
    GROUP BY user_id, marketplace
    HAVING COUNT(*) > 1 OR COUNT(DISTINCT ml_user_id) > 1
  ) AS mono_conflicts;

  WITH uq AS (
    SELECT
      c.conname,
      array_agg(a.attname ORDER BY u.ordinality) AS col_names
    FROM pg_constraint AS c
    JOIN pg_class AS rel ON rel.oid = c.conrelid
    JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ordinality)
    JOIN pg_attribute AS a
      ON a.attrelid = c.conrelid
     AND a.attnum = u.attnum
     AND NOT a.attisdropped
    WHERE ns.nspname = 'public'
      AND rel.relname = 'ml_tokens'
      AND c.contype = 'u'
    GROUP BY c.conname, c.conrelid
  )
  SELECT COUNT(*)::integer
  INTO n_legacy_uq
  FROM uq
  WHERE col_names IN (
    ARRAY['user_id', 'marketplace']::name[],
    ARRAY['marketplace', 'user_id']::name[]
  );

  SELECT COUNT(*)::integer
  INTO n_legacy_idx
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'ml_tokens'
    AND indexdef ~* '^CREATE UNIQUE INDEX'
    AND (
      (indexdef LIKE '%(user_id, marketplace)%' OR indexdef LIKE '%(marketplace, user_id)%')
      AND indexdef NOT LIKE '%ml_user_id%'
    )
    AND indexname IS DISTINCT FROM 'ml_tokens_user_marketplace_ml_user_uidx';

  IF n_triple_dup > 0 THEN
    RAISE EXCEPTION
      'ml_tokens: existem % grupo(s) duplicados em (user_id, marketplace, ml_user_id). Corrija o passo C (ou bloco J) antes de criar o índice.',
      n_triple_dup
      USING ERRCODE = 'check_violation';
  END IF;

  IF n_mono_conflict > 0 THEN
    RAISE EXCEPTION
      'ml_tokens: existem % par(es) (user_id, marketplace) com mais de um ml_user_id ou mais de uma linha. Corrija o passo D (ou bloco J) antes de criar o índice.',
      n_mono_conflict
      USING ERRCODE = 'check_violation';
  END IF;

  IF n_legacy_uq > 0 THEN
    RAISE EXCEPTION
      'ml_tokens: ainda existe % constraint(s) UNIQUE legado(s) só em (user_id, marketplace). Rode os ALTER TABLE ... DROP CONSTRAINT do passo E e execute este script de novo.',
      n_legacy_uq
      USING ERRCODE = 'check_violation';
  END IF;

  IF n_legacy_idx > 0 THEN
    RAISE EXCEPTION
      'ml_tokens: ainda existe % índice(s) UNIQUE legado(s) só em (user_id, marketplace). Rode os DROP INDEX do passo E2 e execute este script de novo.',
      n_legacy_idx
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE $sql$
    CREATE UNIQUE INDEX IF NOT EXISTS ml_tokens_user_marketplace_ml_user_uidx
      ON public.ml_tokens (user_id, marketplace, ml_user_id)
  $sql$;

  EXECUTE $sql$
    COMMENT ON INDEX public.ml_tokens_user_marketplace_ml_user_uidx IS
      'Suse7 ML multi-conta: upsert PostgREST onConflict user_id,marketplace,ml_user_id.'
  $sql$;

  RAISE NOTICE 'ml_tokens: índice único ml_tokens_user_marketplace_ml_user_uidx criado ou já existia (IF NOT EXISTS).';
END
$migration$;

-- ======================================================================
-- G) Verificação pós-migração — índices em ml_tokens
-- ======================================================================
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'ml_tokens'
ORDER BY indexname;

-- ======================================================================
-- H) Desalinhamento ml_tokens ↔ marketplace_accounts (Mercado Livre)
--     token_matches_account = false → sem linha de token com ml_user_id = external_seller_id
-- ======================================================================
SELECT
  ma.id AS marketplace_account_id,
  ma.user_id,
  ma.seller_company_id AS account_seller_company_id,
  ma.external_seller_id,
  ma.marketplace,
  mt.id AS ml_token_id,
  mt.ml_user_id,
  mt.marketplace_account_id AS token_marketplace_account_id,
  mt.seller_company_id AS token_seller_company_id,
  CASE
    WHEN mt.ml_user_id IS NULL THEN false
    WHEN mt.ml_user_id::text = ma.external_seller_id::text THEN true
    ELSE false
  END AS token_matches_account
FROM public.marketplace_accounts AS ma
LEFT JOIN public.ml_tokens AS mt
  ON mt.user_id = ma.user_id
 AND mt.ml_user_id::text = ma.external_seller_id::text
 AND mt.marketplace::text = ma.marketplace::text
WHERE ma.marketplace IN ('mercado_livre', 'mercadolivre')
ORDER BY ma.user_id, ma.id;

-- Tokens sem conta correspondente (external_seller_id igual)
SELECT
  mt.id,
  mt.user_id,
  mt.marketplace,
  mt.ml_user_id,
  mt.marketplace_account_id,
  mt.updated_at
FROM public.ml_tokens AS mt
LEFT JOIN public.marketplace_accounts AS ma
  ON ma.user_id = mt.user_id
 AND ma.external_seller_id::text = mt.ml_user_id::text
 AND ma.marketplace::text = mt.marketplace::text
WHERE ma.id IS NULL
  AND mt.marketplace IN ('mercado_livre', 'mercadolivre')
ORDER BY mt.user_id, mt.updated_at DESC NULLS LAST, mt.id DESC;

-- ======================================================================
-- J) OPCIONAL — DEV: limpeza controlada (TUDO COMENTADO)
--
-- Use SOMENTE se:
--   - C ou D mostrarem lixo claro em DEV
--   - Você identificou os ids exatos a manter / remover
--
-- Exemplo: manter o token mais recente por (user_id, marketplace, ml_user_id)
-- e apagar duplicatas exatas de chave tripla (ajuste antes de descomentar).
--
/*
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, marketplace, ml_user_id
      ORDER BY id DESC
    ) AS rn
  FROM public.ml_tokens
)
DELETE FROM public.ml_tokens t
USING ranked r
WHERE t.id = r.id
  AND r.rn > 1;
*/

-- Exemplo: para (user_id, marketplace) com vários ml_user_id em DEV,
-- você pode apagar tokens órfãos SEM marketplace_account correspondente
-- (revisar com SELECT na seção H antes).
/*
DELETE FROM public.ml_tokens mt
WHERE mt.id IN (
  SELECT mt2.id
  FROM public.ml_tokens mt2
  LEFT JOIN public.marketplace_accounts ma
    ON ma.user_id = mt2.user_id
   AND ma.external_seller_id::text = mt2.ml_user_id::text
   AND ma.marketplace::text = mt2.marketplace::text
  WHERE ma.id IS NULL
    AND mt2.marketplace IN ('mercado_livre', 'mercadolivre')
);
*/

-- FIM
