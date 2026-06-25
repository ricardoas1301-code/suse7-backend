-- ======================================================================
-- Diagnóstico manual — rodar no SQL Editor do Supabase se migration falhar
-- ======================================================================

-- Colunas atuais
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 's7_global_customers'
ORDER BY ordinal_position;

-- Índices atuais
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 's7_global_customers';
