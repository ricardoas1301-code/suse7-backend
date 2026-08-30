-- ======================================================================
-- CPJ-2 Ticket 1 — ml_tokens multi-conta Mercado Livre
--
-- Problema (RCA):
--   UNIQUE legado em (user_id, marketplace) impede 2º seller ML no mesmo tenant.
--   O upsert PostgREST usa onConflict (user_id, marketplace, ml_user_id) → 42P10
--   e o insert legado colide com 23505 na UNIQUE mono-conta.
--
-- Solução:
--   1) Remover UNIQUE/INDEX legado só (user_id, marketplace)
--   2) Garantir UNIQUE (user_id, marketplace, ml_user_id)
--   3) Adicionar marketplace_account_id (vínculo opcional à connection)
--
-- Idempotente / segura para reexecução.
-- NÃO apaga tokens existentes.
-- ======================================================================

SET search_path TO public;

-- Guard: bloquear se já existem duas linhas com o mesmo triple (não deveria)
DO $guard_triple$
DECLARE
  n_dup integer;
BEGIN
  SELECT COUNT(*)::integer INTO n_dup
  FROM (
    SELECT 1
    FROM public.ml_tokens
    GROUP BY user_id, marketplace, ml_user_id
    HAVING COUNT(*) > 1
  ) d;
  IF n_dup > 0 THEN
    RAISE EXCEPTION
      'ml_tokens: % grupo(s) duplicados em (user_id, marketplace, ml_user_id). Limpe antes da migration.',
      n_dup;
  END IF;
END
$guard_triple$;

-- Drop UNIQUE CONSTRAINT legado (user_id, marketplace) sem ml_user_id
DO $drop_legacy_uq$
DECLARE
  r record;
BEGIN
  FOR r IN
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
    SELECT conname
    FROM uq
    WHERE col_names IN (
      ARRAY['user_id', 'marketplace']::name[],
      ARRAY['marketplace', 'user_id']::name[]
    )
  LOOP
    EXECUTE format('ALTER TABLE public.ml_tokens DROP CONSTRAINT IF EXISTS %I', r.conname);
    RAISE NOTICE 'Dropped legacy UNIQUE constraint %', r.conname;
  END LOOP;
END
$drop_legacy_uq$;

-- Drop UNIQUE INDEX legado (user_id, marketplace) sem ml_user_id
DO $drop_legacy_idx$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'ml_tokens'
      AND indexdef ~* '^CREATE UNIQUE INDEX'
      AND (
        (indexdef LIKE '%(user_id, marketplace)%' OR indexdef LIKE '%(marketplace, user_id)%')
        AND indexdef NOT LIKE '%ml_user_id%'
      )
      AND indexname IS DISTINCT FROM 'ml_tokens_user_marketplace_ml_user_uidx'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexname);
    RAISE NOTICE 'Dropped legacy UNIQUE index %', r.indexname;
  END LOOP;
END
$drop_legacy_idx$;

-- Índice canônico multi-conta (PostgREST onConflict)
CREATE UNIQUE INDEX IF NOT EXISTS ml_tokens_user_marketplace_ml_user_uidx
  ON public.ml_tokens (user_id, marketplace, ml_user_id);

COMMENT ON INDEX public.ml_tokens_user_marketplace_ml_user_uidx IS
  'CPJ2-T1: upsert ml_tokens por (user_id, marketplace, ml_user_id) — multi-conta.';

-- Vínculo opcional à connection (marketplace_accounts.id)
ALTER TABLE public.ml_tokens
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid;

CREATE INDEX IF NOT EXISTS ml_tokens_marketplace_account_id_idx
  ON public.ml_tokens (marketplace_account_id)
  WHERE marketplace_account_id IS NOT NULL;
