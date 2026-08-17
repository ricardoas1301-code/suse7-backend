-- ======================================================================
-- S7-S4 | Auditoria RLS — schema public (rodar no SQL Editor Supabase)
-- Complementa: supabase/diagnostics/s7_rls_marketplace_sales_audit.sql
-- ======================================================================

-- 1) Inventário: todas as tabelas public + RLS + contagem de policies
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  COALESCE(p.policy_count, 0) AS policy_count,
  CASE
    WHEN NOT c.relrowsecurity THEN 'CRITICO — RLS desabilitado'
    WHEN COALESCE(p.policy_count, 0) = 0 THEN 'ALERTA — RLS ON sem policies (service_role only)'
    ELSE 'OK — RLS + policies'
  END AS exposure_level
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN (
  SELECT tablename, count(*)::int AS policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
  GROUP BY tablename
) p ON p.tablename = c.relname
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY
  CASE WHEN NOT c.relrowsecurity THEN 0 WHEN COALESCE(p.policy_count, 0) = 0 THEN 1 ELSE 2 END,
  c.relname;

-- 2) Somente tabelas SEM RLS (Security Advisor rls_disabled_in_public)
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT c.relrowsecurity
ORDER BY c.relname;

-- 3) Policies permissivas (USING true / WITH CHECK true) — revisar manualmente
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    qual IS NOT DISTINCT FROM 'true'
    OR with_check IS NOT DISTINCT FROM 'true'
  )
ORDER BY tablename, policyname;

-- 4) Privilégios anon em tabelas public (esperado: zero ou só catálogo read-only)
SELECT
  table_name,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee = 'anon'
GROUP BY table_name
ORDER BY table_name;

-- 5) Privilégios authenticated (referência)
SELECT
  table_name,
  string_agg(DISTINCT privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee = 'authenticated'
GROUP BY table_name
ORDER BY table_name;

-- 6) Detalhe policies por tabela operacional SUS7 (amostra)
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles',
    'products',
    'product_variants',
    'product_image_links',
    'marketplace_accounts',
    'seller_companies',
    'marketplace_customers',
    'marketplace_listings',
    'sales_orders',
    'ml_tokens',
    'oauth_states',
    'ml_webhook_events',
    'marketplace_account_sync_jobs',
    's7_notification_events',
    's7_notification_dispatches',
    'billing_customers',
    'billing_subscriptions',
    'billing_payments',
    'competition_competitors',
    'competition_monitored_listings'
  )
ORDER BY tablename, policyname;
