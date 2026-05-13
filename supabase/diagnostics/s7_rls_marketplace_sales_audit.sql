-- ======================================================================
-- S7 | Auditoria pós-RLS (DEV/PROD) — rodar no SQL Editor após aplicar
-- 20260513153000_s7_marketplace_sales_rls_hardening.sql
-- 20260513160000_s7_revoke_anon_marketplace_sales_grants.sql
-- ======================================================================

-- 1) RLS habilitado nas tabelas alvo
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'marketplace_listings',
    'sales_orders',
    'sales_order_items',
    'listing_sales_metrics',
    'marketplace_listing_health',
    'marketplace_listing_health_history',
    'marketplace_listing_attributes',
    'marketplace_listing_descriptions',
    'marketplace_listing_pictures',
    'marketplace_listing_shipping',
    'marketplace_listing_variations',
    'marketplace_listing_raw_snapshots',
    'marketplace_listing_snapshots',
    'order_raw_snapshots',
    's7_schema_migrations'
  )
ORDER BY c.relname;

-- 2) Policies por tabela (esperado: 4 policies authenticated em fases 1–3; 0 em s7_schema_migrations)
SELECT
  schemaname,
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'marketplace_listings',
    'sales_orders',
    'sales_order_items',
    'listing_sales_metrics',
    'marketplace_listing_health',
    'marketplace_listing_health_history',
    'marketplace_listing_attributes',
    'marketplace_listing_descriptions',
    'marketplace_listing_pictures',
    'marketplace_listing_shipping',
    'marketplace_listing_variations',
    'marketplace_listing_raw_snapshots',
    'marketplace_listing_snapshots',
    'order_raw_snapshots',
    's7_schema_migrations'
  )
ORDER BY tablename, policyname;

-- 3) Alerta: policies permissivas (USING true) em tabelas sensíveis
SELECT tablename, policyname, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'marketplace_listings',
    'sales_orders',
    'sales_order_items',
    'listing_sales_metrics',
    'marketplace_listing_health',
    'marketplace_listing_health_history',
    'marketplace_listing_attributes',
    'marketplace_listing_descriptions',
    'marketplace_listing_pictures',
    'marketplace_listing_shipping',
    'marketplace_listing_variations',
    'marketplace_listing_raw_snapshots',
    'marketplace_listing_snapshots',
    'order_raw_snapshots'
  )
  AND (
    qual IS NOT DISTINCT FROM 'true'
    OR with_check IS NOT DISTINCT FROM 'true'
  );

-- 4) Privilégios de tabela (authenticated vs service_role)
SELECT
  table_name,
  grantee,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN (
    'marketplace_listings',
    'sales_orders',
    'sales_order_items',
    'listing_sales_metrics',
    'marketplace_listing_health',
    'marketplace_listing_health_history',
    'marketplace_listing_attributes',
    'marketplace_listing_descriptions',
    'marketplace_listing_pictures',
    'marketplace_listing_shipping',
    'marketplace_listing_variations',
    'marketplace_listing_raw_snapshots',
    'marketplace_listing_snapshots',
    'order_raw_snapshots',
    's7_schema_migrations'
  )
  AND grantee IN ('authenticated', 'service_role', 'anon')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- 5) Alerta: anon ainda com privilégios (esperado: zero linhas)
SELECT
  table_name,
  grantee,
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND table_name IN (
    'marketplace_listings',
    'sales_orders',
    'sales_order_items',
    'listing_sales_metrics',
    'marketplace_listing_health',
    'marketplace_listing_health_history',
    'marketplace_listing_attributes',
    'marketplace_listing_descriptions',
    'marketplace_listing_pictures',
    'marketplace_listing_shipping',
    'marketplace_listing_variations',
    'marketplace_listing_raw_snapshots',
    'marketplace_listing_snapshots',
    'order_raw_snapshots',
    's7_schema_migrations'
  )
GROUP BY table_name, grantee
ORDER BY table_name;

-- 6) Checklist manual pós-DEV (não executável aqui):
--    login, dashboard, vendas, anúncios, sync ML, jobs/cron, webhooks, queries frontend, backend service_role.
