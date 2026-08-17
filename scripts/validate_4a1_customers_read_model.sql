-- =============================================================================
-- Validação — Sprint 1 Fase 4A.1 (Clientes 360 read model + idempotência)
-- Não imprime PII completo.
-- =============================================================================

-- A) Coluna de idempotência
SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sales_orders'
      AND column_name = 'customer_ingested_at'
  ) AS has_customer_ingested_at;

-- B) Painel ingestão / materialização
SELECT
  count(*)::bigint AS orders_total,
  count(*) FILTER (WHERE customer_ingested_at IS NOT NULL)::bigint AS orders_materialized,
  count(*) FILTER (WHERE customer_ingested_at IS NULL)::bigint AS orders_pending_materialization
FROM public.sales_orders;

-- C) Spot-check: recompute vs listagem (amostra por buyer)
WITH sample AS (
  SELECT
    mc.id AS customer_id,
    mc.external_customer_id,
    mc.marketplace,
    mc.marketplace_account_id,
    mc.seller_company_id,
    mc.user_id
  FROM public.marketplace_customers mc
  WHERE nullif(trim(mc.external_customer_id), '') IS NOT NULL
  ORDER BY mc.updated_at DESC NULLS LAST
  LIMIT 5
),
order_agg AS (
  SELECT
    s.user_id,
    s.marketplace,
    s.marketplace_account_id,
    s.seller_company_id,
    nullif(trim(s.raw_json::jsonb #>> '{buyer,id}'), '') AS external_customer_id,
    count(*)::bigint AS orders_from_sales,
    coalesce(sum(s.total_amount), 0)::numeric(18, 2) AS spent_from_sales
  FROM public.sales_orders s
  WHERE nullif(trim(s.raw_json::jsonb #>> '{buyer,id}'), '') IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5
)
SELECT
  sample.customer_id,
  sample.external_customer_id,
  coalesce(order_agg.orders_from_sales, 0) AS orders_from_sales,
  coalesce(order_agg.spent_from_sales, 0) AS spent_from_sales
FROM sample
LEFT JOIN order_agg
  ON order_agg.user_id = sample.user_id
 AND order_agg.marketplace IS NOT DISTINCT FROM sample.marketplace
 AND order_agg.marketplace_account_id IS NOT DISTINCT FROM sample.marketplace_account_id
 AND order_agg.seller_company_id IS NOT DISTINCT FROM sample.seller_company_id
 AND order_agg.external_customer_id = sample.external_customer_id;

-- D) Idempotência: pedidos marcados não devem ser maioria NULL após ingest em prod
SELECT
  count(*) FILTER (
    WHERE customer_ingested_at IS NOT NULL
      AND nullif(trim(raw_json::jsonb #>> '{buyer,id}'), '') IS NOT NULL
  )::bigint AS ingested_with_buyer,
  count(*) FILTER (
    WHERE customer_ingested_at IS NULL
      AND nullif(trim(raw_json::jsonb #>> '{buyer,id}'), '') IS NOT NULL
  )::bigint AS pending_with_buyer
FROM public.sales_orders;
