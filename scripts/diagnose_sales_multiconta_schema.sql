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
DROP TABLE IF EXISTS tmp_diag_sales_sample;
CREATE TEMP TABLE tmp_diag_sales_sample (
  sales_order_id_prefix text,
  marketplace_account_id_prefix text,
  seller_company_id_prefix text,
  marketplace text,
  external_order_id_prefix text,
  date_created_marketplace text,
  updated_at text
);

DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'marketplace_account_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM public.sales_orders WHERE marketplace_account_id IS NULL'
      INTO v_count;
    RAISE NOTICE 'sales_orders_sem_marketplace_account_id: %', v_count;
  ELSE
    RAISE NOTICE 'sales_orders.marketplace_account_id não existe';
  END IF;
END $$;

-- 3) Vendas sem seller_company_id
DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'seller_company_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM public.sales_orders WHERE seller_company_id IS NULL'
      INTO v_count;
    RAISE NOTICE 'sales_orders_sem_seller_company_id: %', v_count;
  ELSE
    RAISE NOTICE 'sales_orders.seller_company_id não existe';
  END IF;
END $$;

-- 4) Itens sem marketplace_account_id
DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'marketplace_account_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM public.sales_order_items WHERE marketplace_account_id IS NULL'
      INTO v_count;
    RAISE NOTICE 'sales_order_items_sem_marketplace_account_id: %', v_count;
  ELSE
    RAISE NOTICE 'sales_order_items.marketplace_account_id não existe';
  END IF;
END $$;

-- 5) Clientes sem marketplace_account_id
DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_customers' AND column_name = 'marketplace_account_id'
  ) THEN
    EXECUTE 'SELECT COUNT(*)::bigint FROM public.marketplace_customers WHERE marketplace_account_id IS NULL'
      INTO v_count;
    RAISE NOTICE 'marketplace_customers_sem_marketplace_account_id: %', v_count;
  ELSE
    RAISE NOTICE 'marketplace_customers.marketplace_account_id não existe';
  END IF;
END $$;

-- 6) Duplicidades por marketplace + conta + external_order_id
DO $$
DECLARE
  v_count bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'marketplace_account_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'external_order_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'marketplace'
  ) THEN
    EXECUTE '
      SELECT COUNT(*)::bigint
      FROM (
        SELECT 1
        FROM public.sales_orders
        WHERE marketplace_account_id IS NOT NULL
          AND external_order_id IS NOT NULL
        GROUP BY marketplace, marketplace_account_id, external_order_id
        HAVING COUNT(*) > 1
      ) d
    ' INTO v_count;
    RAISE NOTICE 'sales_orders_duplicidades_marketplace_account_external_order: %', v_count;
  ELSE
    RAISE NOTICE 'colunas necessárias para duplicidades não existem em sales_orders';
  END IF;
END $$;

-- 7) Amostra segura (IDs parciais, sem tokens/secrets)
DO $$
DECLARE
  has_mkt boolean;
  has_acc boolean;
  has_seller boolean;
  has_ext boolean;
  has_date boolean;
  has_upd boolean;
  q text;
BEGIN
  IF to_regclass('public.sales_orders') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'marketplace'
    ) INTO has_mkt;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'marketplace_account_id'
    ) INTO has_acc;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'seller_company_id'
    ) INTO has_seller;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'external_order_id'
    ) INTO has_ext;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'date_created_marketplace'
    ) INTO has_date;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'updated_at'
    ) INTO has_upd;

    q := 'INSERT INTO tmp_diag_sales_sample ' ||
      'SELECT LEFT(COALESCE(so.id::text, ''''), 8) AS sales_order_id_prefix, ' ||
      CASE WHEN has_acc THEN 'LEFT(COALESCE(so.marketplace_account_id::text, ''''), 8)' ELSE '''''' END ||
      ' AS marketplace_account_id_prefix, ' ||
      CASE WHEN has_seller THEN 'LEFT(COALESCE(so.seller_company_id::text, ''''), 8)' ELSE '''''' END ||
      ' AS seller_company_id_prefix, ' ||
      CASE WHEN has_mkt THEN 'so.marketplace' ELSE 'NULL::text' END ||
      ' AS marketplace, ' ||
      CASE WHEN has_ext THEN 'LEFT(COALESCE(so.external_order_id, ''''), 16)' ELSE '''''' END ||
      ' AS external_order_id_prefix, ' ||
      CASE WHEN has_date THEN 'so.date_created_marketplace::text' ELSE 'NULL::text' END ||
      ' AS date_created_marketplace, ' ||
      CASE WHEN has_upd THEN 'so.updated_at::text' ELSE 'NULL::text' END ||
      ' AS updated_at FROM public.sales_orders so ' ||
      CASE WHEN has_upd THEN 'ORDER BY so.updated_at DESC NULLS LAST ' ELSE '' END ||
      'LIMIT 50';

    EXECUTE q;
  ELSE
    RAISE NOTICE 'sales_orders não existe';
  END IF;
END $$;

SELECT * FROM tmp_diag_sales_sample;

