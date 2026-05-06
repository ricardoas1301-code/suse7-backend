-- =============================================================================
-- E2E — Validação: shipment_snapshot + ingestão Clientes 360 (pós novo sync)
-- Rode APÓS: deploy backend, sync ML, POST ingest-from-sales ou "Atualizar base".
-- Não imprime PII completo nas amostras.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A) Painel único — marketplace_sales (raw_payload)
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*)::bigint
   FROM public.marketplace_sales ms
   WHERE ms.raw_payload IS NOT NULL
     AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,email}'), '') IS NOT NULL)
    AS cnt_snapshot_buyer_email,
  (SELECT count(*)::bigint
   FROM public.marketplace_sales ms
   WHERE ms.raw_payload IS NOT NULL
     AND nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,number}'), '') IS NOT NULL)
    AS cnt_snapshot_buyer_phone_number,
  (SELECT count(*)::bigint
   FROM public.marketplace_sales ms
   WHERE ms.raw_payload IS NOT NULL
     AND nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_phone}'), '') IS NOT NULL)
    AS cnt_shipment_snapshot_receiver_phone,
  (SELECT count(*)::bigint
   FROM public.marketplace_sales ms
   WHERE ms.raw_payload IS NOT NULL
     AND nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_address,phone}'), '') IS NOT NULL)
    AS cnt_shipment_snapshot_receiver_address_phone,
  (SELECT count(*)::bigint
   FROM public.marketplace_sales ms
   WHERE ms.raw_payload IS NOT NULL
     AND jsonb_typeof(ms.raw_payload::jsonb -> 'shipment_snapshot') = 'object')
    AS cnt_rows_objeto_shipment_snapshot;

-- ---------------------------------------------------------------------------
-- B) Painel único — marketplace_customers (pós-ingestão)
-- ---------------------------------------------------------------------------
SELECT
  count(*)::bigint AS total,
  count(mc.email) FILTER (WHERE nullif(trim(mc.email), '') IS NOT NULL)::bigint AS com_email,
  count(mc.whatsapp_e164) FILTER (WHERE nullif(trim(mc.whatsapp_e164), '') IS NOT NULL)::bigint AS com_whatsapp_e164,
  count(*) FILTER (
    WHERE (mc.email IS NULL OR trim(mc.email) = '')
      AND (mc.phone IS NULL OR trim(mc.phone) = '')
      AND (mc.whatsapp IS NULL OR trim(mc.whatsapp) = '')
      AND (mc.whatsapp_e164 IS NULL OR trim(mc.whatsapp_e164) = '')
  )::bigint AS sem_contato
FROM public.marketplace_customers mc;

-- ---------------------------------------------------------------------------
-- C) Amostras mascaradas — vendas (linhas com qualquer contato detectável)
-- ---------------------------------------------------------------------------
SELECT
  ms.id,
  left(nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,email}'), ''), 3) || '***' AS buyer_email_prefixo,
  right(nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,number}'), ''), 4) AS buyer_phone_last4,
  right(nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_phone}'), ''), 4) AS ship_recv_phone_last4,
  right(nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_address,phone}'), ''), 4) AS ship_recvaddr_phone_last4,
  jsonb_typeof(ms.raw_payload::jsonb -> 'shipment_snapshot') = 'object' AS tem_shipment_snapshot_objeto
FROM public.marketplace_sales ms
WHERE ms.raw_payload IS NOT NULL
  AND (
    nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,email}'), '') IS NOT NULL
    OR nullif(trim(ms.raw_payload::jsonb #>> '{order_snapshot,buyer,phone,number}'), '') IS NOT NULL
    OR nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_phone}'), '') IS NOT NULL
    OR nullif(trim(ms.raw_payload::jsonb #>> '{shipment_snapshot,receiver_address,phone}'), '') IS NOT NULL
  )
ORDER BY ms.synced_at DESC NULLS LAST
LIMIT 10;

-- ---------------------------------------------------------------------------
-- D) Amostras mascaradas — clientes (após ingestão)
-- ---------------------------------------------------------------------------
SELECT
  mc.id,
  left(nullif(trim(mc.email), ''), 3) || '***' AS email_prefixo,
  mc.email_is_masked,
  CASE
    WHEN mc.whatsapp_e164 IS NOT NULL AND length(regexp_replace(mc.whatsapp_e164, '\D', '', 'g')) >= 4
      THEN '***' || right(regexp_replace(mc.whatsapp_e164, '\D', '', 'g'), 4)
    ELSE NULL
  END AS whatsapp_e164_final_mascarado,
  mc.contact_source
FROM public.marketplace_customers mc
WHERE nullif(trim(mc.email), '') IS NOT NULL
   OR nullif(trim(mc.whatsapp_e164), '') IS NOT NULL
ORDER BY mc.contact_updated_at DESC NULLS LAST, mc.updated_at DESC NULLS LAST
LIMIT 10;
