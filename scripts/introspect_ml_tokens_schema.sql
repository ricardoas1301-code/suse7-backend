-- S7 — colunas e índices de public.ml_tokens (rodar no SQL Editor do Supabase / psql).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'ml_tokens'
ORDER BY ordinal_position;

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'ml_tokens'
ORDER BY indexname;
