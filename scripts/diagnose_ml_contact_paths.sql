-- =============================================================================
-- Diagnóstico: onde o ML expõe contato em marketplace_sales.raw_payload
-- Rode no SQL Editor do Supabase. Não retorna PII completo nas amostras finais.
-- =============================================================================

-- marketplace_sales existe?
SELECT to_regclass('public.marketplace_sales') IS NOT NULL AS tem_marketplace_sales;

-- marketplace_orders existe? (ledger alternativo)
SELECT to_regclass('public.marketplace_orders') IS NOT NULL AS tem_marketplace_orders;

-- ---------------------------------------------------------------------------
-- 1) Caminhos ERRADOS (raiz buyer) — costuma dar 0 no Suse7 porque buyer fica em order_snapshot
-- ---------------------------------------------------------------------------
SELECT count(*)::bigint AS cnt_raiz_buyer_email
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{buyer,email}'), '') IS NOT NULL;

SELECT count(*)::bigint AS cnt_raiz_buyer_phone_number
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{buyer,phone,number}'), '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Caminhos REAIS do sync atual (order_snapshot = GET /orders/:id persistido pelo mapper)
-- ---------------------------------------------------------------------------
SELECT count(*)::bigint AS cnt_snapshot_buyer_email
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,email}'), '') IS NOT NULL;

SELECT count(*)::bigint AS cnt_snapshot_buyer_phone_number
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,number}'), '') IS NOT NULL;

SELECT count(*)::bigint AS cnt_snapshot_buyer_phone_area
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,area_code}'), '') IS NOT NULL;

-- shipping em snapshot (muitas vezes só id até enriquecer com GET /shipments/:id)
SELECT count(*)::bigint AS cnt_snapshot_shipping_is_object
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND jsonb_typeof(ms.raw_payload::jsonb -> 'order_snapshot' -> 'shipping') = 'object';

SELECT count(*)::bigint AS cnt_snapshot_shipping_receiver_phone
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,shipping,receiver_phone}'), '') IS NOT NULL;

SELECT count(*)::bigint AS cnt_snapshot_shipping_recvaddr_phone
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,shipping,receiver_address,phone}'), '') IS NOT NULL;

-- shipment_snapshot (preenchido após sync com GET /shipments/:id)
SELECT count(*)::bigint AS cnt_shipment_snapshot_receiver_phone
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_phone}'), '') IS NOT NULL;

SELECT count(*)::bigint AS cnt_shipment_snapshot_recvaddr_phone
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_address,phone}'), '') IS NOT NULL;

-- Alias explícito (mesma métrica da linha anterior — checklist de validação)
SELECT count(*)::bigint AS cnt_shipment_snapshot_receiver_address_phone
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_address,phone}'), '') IS NOT NULL;

-- Linhas com shipment_snapshot preenchido (objeto JSON)
SELECT count(*)::bigint AS cnt_rows_com_shipment_snapshot
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND jsonb_typeof(ms.raw_payload::jsonb -> 'shipment_snapshot') = 'object';

-- billing_info na raiz do pedido (quando existir)
SELECT count(*)::bigint AS cnt_order_snapshot_billing
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND (ms.raw_payload::jsonb -> 'order_snapshot' ? 'billing_info');

-- ---------------------------------------------------------------------------
-- 3) Colunas desnormalizadas em marketplace_sales (se preenchidas na importação)
-- ---------------------------------------------------------------------------
SELECT
  count(*) FILTER (WHERE buyer_email IS NOT NULL AND trim(buyer_email) <> '')::bigint AS col_buyer_email,
  count(*) FILTER (WHERE buyer_phone IS NOT NULL AND trim(buyer_phone) <> '')::bigint AS col_buyer_phone
FROM public.marketplace_sales;

-- ---------------------------------------------------------------------------
-- 4) marketplace_orders (estrutura ledger — line_raw / raw_payload)
-- ---------------------------------------------------------------------------
SELECT count(*)::bigint AS orders_rows_com_line_raw_phone
FROM public.marketplace_orders mo
WHERE mo.raw_payload IS NOT NULL
  AND nullif(trim(mo.raw_payload::jsonb #>> '{line_raw,buyer,phone,number}'), '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) Amostra MASCARADA (máx 15 linhas com algum sinal de contato no JSON)
-- ---------------------------------------------------------------------------
SELECT
  ms.id,
  left(nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,email}'), ''), 3) || '***' AS email_prefixo,
  ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,area_code}' AS ddd,
  right(nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,number}'), ''), 4) AS phone_last4,
  (ms.raw_payload::jsonb #>> '{order_snapshot,shipping,receiver_phone}') IS NOT NULL AS tem_recv_phone_snap,
  (ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_phone}') IS NOT NULL AS tem_recv_phone_shipsnap,
  right(nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_address,phone}'), ''), 4) AS ship_recvaddr_phone_last4,
  (ms.raw_payload::jsonb -> 'shipment_snapshot') IS NOT NULL AS tem_shipment_snapshot
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND (
    nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,email}'), '') IS NOT NULL
    OR nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,number}'), '') IS NOT NULL
    OR nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,shipping,receiver_phone}'), '') IS NOT NULL
    OR nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_phone}'), '') IS NOT NULL
  )
ORDER BY ms.synced_at DESC NULLS LAST
LIMIT 15;
