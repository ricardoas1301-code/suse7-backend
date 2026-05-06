-- ============================================================
-- S7 Diagnose | Sales multiconta schema + qualidade de vínculo
-- ============================================================

-- 1) Colunas existentes nas tabelas críticas
SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'sales_orders',
    'sales_order_items',
    'marketplace_customers',
    'marketplace_listings',
    'marketplace_accounts',
    'seller_companies'
  )
ORDER BY table_name, ordinal_position;

-- 2) Vendas sem marketplace_account_id
SELECT 'sales_orders_sem_marketplace_account_id' AS metric, COUNT(*)::bigint AS total
FROM public.sales_orders
WHERE marketplace_account_id IS NULL;

-- 3) Vendas sem seller_company_id
SELECT 'sales_orders_sem_seller_company_id' AS metric, COUNT(*)::bigint AS total
FROM public.sales_orders
WHERE seller_company_id IS NULL;

-- 4) Itens sem marketplace_account_id
SELECT 'sales_order_items_sem_marketplace_account_id' AS metric, COUNT(*)::bigint AS total
FROM public.sales_order_items
WHERE marketplace_account_id IS NULL;

-- 5) Clientes sem marketplace_account_id
SELECT 'marketplace_customers_sem_marketplace_account_id' AS metric, COUNT(*)::bigint AS total
FROM public.marketplace_customers
WHERE marketplace_account_id IS NULL;

-- 6) Duplicidades por marketplace + conta + external_order_id
SELECT
  marketplace,
  marketplace_account_id,
  external_order_id,
  COUNT(*)::bigint AS qty
FROM public.sales_orders
WHERE marketplace_account_id IS NOT NULL
  AND external_order_id IS NOT NULL
GROUP BY marketplace, marketplace_account_id, external_order_id
HAVING COUNT(*) > 1
ORDER BY qty DESC, marketplace, external_order_id
LIMIT 100;

-- 7) Amostra segura (IDs parciais, sem tokens/secrets)
SELECT
  LEFT(COALESCE(so.id::text, ''), 8) AS sales_order_id_prefix,
  LEFT(COALESCE(so.marketplace_account_id::text, ''), 8) AS marketplace_account_id_prefix,
  LEFT(COALESCE(so.seller_company_id::text, ''), 8) AS seller_company_id_prefix,
  so.marketplace,
  LEFT(COALESCE(so.external_order_id, ''), 16) AS external_order_id_prefix,
  so.date_created_marketplace,
  so.updated_at
FROM public.sales_orders so
ORDER BY so.updated_at DESC NULLS LAST
LIMIT 50;

