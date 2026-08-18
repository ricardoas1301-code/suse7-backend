-- Bridge: baseline export contém sales_orders/items legado (order_id).
-- Fresh V2 replay precisa do shape phase3 (sales_order_id) antes das migrations backend.
-- Seguro quando tabelas estão vazias (fresh replay / DEV V2).

DO $$
BEGIN
  IF to_regclass('public.sales_order_items') IS NOT NULL
     AND to_regclass('public.sales_orders') IS NOT NULL
     AND (SELECT count(*)::int FROM public.sales_order_items) = 0
     AND (SELECT count(*)::int FROM public.sales_orders) = 0
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'sales_order_id'
     )
  THEN
    DROP TABLE public.sales_order_items CASCADE;
    DROP TABLE public.sales_orders CASCADE;
  END IF;
END $$;
