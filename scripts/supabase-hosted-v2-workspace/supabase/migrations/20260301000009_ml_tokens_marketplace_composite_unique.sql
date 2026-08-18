-- ======================================================================
-- ml_tokens: coluna marketplace + unicidade (user_id, marketplace)
-- Idempotente para PROD (schema antigo) e DEV (já com coluna).
--
-- Remove a unicidade apenas em user_id (1 token por usuário no total)
-- e passa a permitir um registro por par (usuário, marketplace).
-- ======================================================================

-- 1) Coluna (nullable primeiro se ainda não existir)
ALTER TABLE public.ml_tokens
  ADD COLUMN IF NOT EXISTS marketplace text;

-- 2) Backfill
UPDATE public.ml_tokens
SET marketplace = 'mercado_livre'
WHERE marketplace IS NULL;

-- 3) Default + NOT NULL
ALTER TABLE public.ml_tokens
  ALTER COLUMN marketplace SET DEFAULT 'mercado_livre';

ALTER TABLE public.ml_tokens
  ALTER COLUMN marketplace SET NOT NULL;

COMMENT ON COLUMN public.ml_tokens.marketplace IS 'Slug do marketplace, ex.: mercado_livre';

-- 4) Remover unicidade antiga só em user_id (impede multi-marketplace)
ALTER TABLE public.ml_tokens
  DROP CONSTRAINT IF EXISTS ml_tokens_user_id_unique;

-- Índice único redundante do dump legado (se existir separado da constraint)
DROP INDEX IF EXISTS public.idx_ml_tokens_user_id_unique;

-- 5) Unicidade composta (alvo do onConflict do PostgREST / Supabase JS)
CREATE UNIQUE INDEX IF NOT EXISTS ml_tokens_user_id_marketplace_key
  ON public.ml_tokens (user_id, marketplace);
