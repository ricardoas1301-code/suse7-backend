-- =============================================================================
-- S7 — Diagnóstico de vendas ML ausentes (webhook × persistência × listagem)
--
-- Uso: ajuste os filtros em params e execute no SQL Editor (DEV/PROD).
-- Não expõe tokens; compara fila ml_webhook_events com sales_orders/items.
-- =============================================================================

WITH params AS (
  SELECT
    NULL::uuid AS user_id,
    NULL::uuid AS marketplace_account_id,
    NULL::text AS external_seller_id,
    NULL::text AS external_order_id,
  timestamptz '2026-05-13 14:00:00-03' AS from_ts,
  timestamptz '2026-05-13 15:30:00-03' AS to_ts
),
accounts AS (
  SELECT ma.id, ma.user_id, ma.external_seller_id, ma.seller_company_id
  FROM public.marketplace_accounts ma
  CROSS JOIN params p
  WHERE ma.marketplace = 'mercado_livre'
    AND (p.user_id IS NULL OR ma.user_id = p.user_id)
    AND (p.marketplace_account_id IS NULL OR ma.id = p.marketplace_account_id)
    AND (p.external_seller_id IS NULL OR ma.external_seller_id = p.external_seller_id)
),
webhook_events AS (
  SELECT
    e.id AS event_id,
    e.created_at AS event_received_at,
    e.updated_at AS event_updated_at,
    e.started_at,
    e.completed_at,
    e.heartbeat_at,
    e.status AS event_status,
    e.attempts,
    e.error_message,
    e.last_error_code,
    e.last_error_message,
    e.topic,
    e.resource,
    e.user_id AS ml_user_id,
    e.marketplace_account_id,
    e.dedupe_key,
    regexp_replace(COALESCE(e.resource, ''), '^.*/', '') AS inferred_external_order_id
  FROM public.ml_webhook_events e
  CROSS JOIN params p
  WHERE e.marketplace = 'mercado_livre'
    AND e.created_at >= p.from_ts
    AND e.created_at < p.to_ts
    AND (p.external_order_id IS NULL OR regexp_replace(COALESCE(e.resource, ''), '^.*/', '') = p.external_order_id)
    AND (
      p.marketplace_account_id IS NULL
      OR e.marketplace_account_id = p.marketplace_account_id
    )
),
webhook_orders AS (
  SELECT w.*
  FROM webhook_events w
  WHERE lower(COALESCE(w.topic, '')) = 'orders_v2'
),
sales AS (
  SELECT
    so.id AS sales_order_id,
    so.user_id,
    so.marketplace_account_id,
    so.seller_company_id,
    so.external_order_id,
    so.external_pack_id,
    so.order_status,
    so.order_substatus,
    so.date_created_marketplace,
    so.paid_at,
    so.api_imported_at,
    so.api_last_seen_at,
    so.created_at AS sales_order_created_at,
    so.updated_at AS sales_order_updated_at
  FROM public.sales_orders so
  INNER JOIN accounts a ON a.id = so.marketplace_account_id
  CROSS JOIN params p
  WHERE so.marketplace = 'mercado_livre'
    AND (
      p.external_order_id IS NULL
      OR so.external_order_id = p.external_order_id
    )
    AND (
      COALESCE(so.date_created_marketplace::timestamptz, so.api_imported_at, so.created_at) >= p.from_ts
      AND COALESCE(so.date_created_marketplace::timestamptz, so.api_imported_at, so.created_at) < p.to_ts
    )
),
item_counts AS (
  SELECT soi.sales_order_id, count(*)::int AS item_count
  FROM public.sales_order_items soi
  INNER JOIN sales s ON s.sales_order_id = soi.sales_order_id
  GROUP BY soi.sales_order_id
),
snapshots AS (
  SELECT
    ors.sales_order_id,
    count(*)::int AS snapshot_count,
    max(ors.created_at) AS last_snapshot_at
  FROM public.order_raw_snapshots ors
  INNER JOIN sales s ON s.sales_order_id = ors.sales_order_id
  GROUP BY ors.sales_order_id
),
joined AS (
  SELECT
    w.event_id,
    w.event_received_at,
    w.event_status,
    w.attempts,
    w.error_message,
    w.last_error_code,
    w.topic,
    w.resource,
    w.ml_user_id,
    w.marketplace_account_id,
    w.inferred_external_order_id,
    s.sales_order_id,
    s.order_status,
    s.order_substatus,
    s.external_pack_id,
    ic.item_count,
    sn.snapshot_count,
    CASE
      WHEN w.event_id IS NULL AND s.sales_order_id IS NOT NULL THEN 'sales_without_webhook_event_in_window'
      WHEN w.event_id IS NOT NULL AND s.sales_order_id IS NULL AND w.event_status IN ('pending', 'processing') THEN 'webhook_queued_or_running'
      WHEN w.event_id IS NOT NULL AND s.sales_order_id IS NULL AND w.event_status = 'error' THEN 'webhook_error'
      WHEN w.event_id IS NOT NULL AND s.sales_order_id IS NULL AND w.event_status = 'ignored' THEN 'webhook_ignored'
      WHEN w.event_id IS NOT NULL AND s.sales_order_id IS NULL AND w.event_status = 'done' THEN 'webhook_done_but_sales_missing'
      WHEN w.event_id IS NOT NULL AND s.sales_order_id IS NOT NULL AND COALESCE(ic.item_count, 0) = 0 THEN 'sales_without_items'
      WHEN w.event_id IS NOT NULL AND s.sales_order_id IS NOT NULL THEN 'matched'
      ELSE 'unclassified'
    END AS diagnosis
  FROM webhook_orders w
  FULL OUTER JOIN sales s
    ON s.external_order_id = w.inferred_external_order_id
   AND (
     w.marketplace_account_id IS NULL
     OR s.marketplace_account_id = w.marketplace_account_id
   )
  LEFT JOIN item_counts ic ON ic.sales_order_id = s.sales_order_id
  LEFT JOIN snapshots sn ON sn.sales_order_id = s.sales_order_id
)
SELECT *
FROM joined
ORDER BY COALESCE(event_received_at, sales_order_created_at) DESC NULLS LAST;

-- Resumo por diagnóstico
-- SELECT diagnosis, count(*) FROM joined GROUP BY 1 ORDER BY 2 DESC;
