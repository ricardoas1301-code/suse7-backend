-- =====================================================================
-- Diagnóstico de estrutura ml_tokens (constraints + índices)
-- Objetivo: confirmar chave multi-conta por (user_id, marketplace, ml_user_id)
-- =====================================================================

SELECT
  conname,
  pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'public.ml_tokens'::regclass
ORDER BY conname;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'ml_tokens'
ORDER BY indexname;
