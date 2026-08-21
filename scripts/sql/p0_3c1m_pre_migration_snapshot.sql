-- P0.3-C.1M — snapshot read-only pré-migration (DEV)

SELECT 'billing_table' AS probe,
  to_regclass('public.billing_billable_sale_admissions') IS NOT NULL AS exists;

SELECT con.conname, pg_get_constraintdef(con.oid, true) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relname = 'billing_billable_sale_admissions'
  AND con.contype = 'c';

SELECT i.relname AS index_name, pg_get_indexdef(i.oid) AS def
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'billing_billable_sale_admissions'
ORDER BY i.relname;

SELECT admission_result, COUNT(*) AS cnt
FROM public.billing_billable_sale_admissions
GROUP BY admission_result
ORDER BY admission_result;

SELECT COUNT(*) AS rf_sales_orders
FROM public.sales_orders
WHERE marketplace_account_id = '359327e4-9902-4213-a1c3-1de702ef92ee'::uuid;

SELECT version
FROM supabase_migrations.schema_migrations
ORDER BY version DESC
LIMIT 8;

SELECT environment, project_ref
FROM public.billing_internal_deployment_identity
WHERE id = 1;
