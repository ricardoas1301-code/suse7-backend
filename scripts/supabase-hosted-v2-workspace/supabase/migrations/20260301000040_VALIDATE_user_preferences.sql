-- ======================================================================
-- VALIDAÇÃO: executar no SQL Editor após aplicar a migration
-- Confirma: estrutura, constraints, triggers, RLS
-- ======================================================================

-- 1) Colunas da tabela
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_preferences'
ORDER BY ordinal_position;

-- 2) Constraint UNIQUE (user_id, key)
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.user_preferences'::regclass;

-- 3) Trigger updated_at
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.user_preferences'::regclass AND NOT tgisinternal;

-- 4) RLS habilitado
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'user_preferences';

-- 5) Policies (4: select, insert, update, delete)
SELECT policyname FROM pg_policies WHERE tablename = 'user_preferences';

-- 6) Teste: listar (vazio se recém-criada)
SELECT * FROM user_preferences LIMIT 1;
