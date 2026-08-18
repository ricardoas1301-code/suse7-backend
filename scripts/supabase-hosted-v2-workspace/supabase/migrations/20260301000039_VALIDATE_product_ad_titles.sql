-- ======================================================================
-- VALIDAÇÃO: executar no SQL Editor após aplicar a migration
-- Confirma: estrutura, constraints, triggers, RLS
-- ======================================================================

-- 1) Tabela existe e tem colunas esperadas
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'product_ad_titles'
ORDER BY ordinal_position;

-- 2) Constraints (u=unique, f=foreign key)
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.product_ad_titles'::regclass;

-- 3) Triggers ativos
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.product_ad_titles'::regclass AND NOT tgisinternal;

-- 4) RLS habilitado
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'product_ad_titles';

-- 5) Policies
SELECT policyname FROM pg_policies WHERE tablename = 'product_ad_titles';

-- 6) Teste: listar (vazio se recém-criada)
SELECT * FROM product_ad_titles LIMIT 5;
