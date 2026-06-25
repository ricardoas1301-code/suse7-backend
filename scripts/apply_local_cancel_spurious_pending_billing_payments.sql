-- =============================================================================
-- S7 BILLING — ATUALIZAÇÃO LOCAL (somente após cancelar no Asaas)
--
-- PRÉ-REQUISITOS:
-- 1) Rodar diagnose_spurious_pending_billing_payments.sql e revisar a lista.
-- 2) Cancelar no Asaas Sandbox (script Node ou painel) — NÃO pule este passo.
-- 3) Colar abaixo os payment_internal_id (UUID) confirmados.
-- 4) Rodar em transação e conferir row count antes do COMMIT.
--
-- NÃO usar em produção. NÃO incluir cobranças pagas/confirmadas.
-- =============================================================================

BEGIN;

-- Cole os UUIDs retornados na seção 1 do diagnóstico:
-- Ex.: 'a1111111-1111-1111-1111-111111111111'::uuid

WITH ids_to_cancel AS (
  SELECT unnest(ARRAY[
    'REPLACE_PAYMENT_UUID_1'::uuid,
    'REPLACE_PAYMENT_UUID_2'::uuid
  ]) AS payment_id
),

updated AS (
  UPDATE billing_payments bp
  SET
    status = 'CANCELED',
    updated_at = now(),
    raw_payload = jsonb_strip_nulls(
      COALESCE(bp.raw_payload, '{}'::jsonb)
      || jsonb_build_object(
        'sandbox_cleanup_at', to_jsonb(now()),
        'sandbox_cleanup_reason', 'spurious_auto_checkout_pre_fix',
        'sandbox_cleanup_by', 'apply_local_cancel_spurious_pending_billing_payments.sql',
        'sandbox_cleanup_previous_status', COALESCE(bp.status, '')
      )
    )
  FROM ids_to_cancel i
  WHERE bp.id = i.payment_id
    AND bp.provider = 'asaas'
    AND lower(trim(coalesce(bp.status, ''))) IN ('pending', 'pendente', 'awaiting_payment', 'overdue', 'vencido', 'past_due')
    AND lower(trim(coalesce(bp.status, ''))) NOT IN ('paid', 'pago', 'received', 'confirmed', 'received_in_cash', 'canceled', 'cancelled')
  RETURNING bp.id, bp.provider_payment_id, bp.status
)

SELECT count(*) AS rows_updated FROM updated;

-- Opcional: marcar assinaturas checkout pendentes órfãs (descomente se necessário)
-- UPDATE billing_subscriptions bs
-- SET
--   status = 'canceled',
--   canceled_at = coalesce(bs.canceled_at, now()),
--   updated_at = now(),
--   metadata = jsonb_strip_nulls(
--     COALESCE(bs.metadata, '{}'::jsonb)
--     || jsonb_build_object(
--       'sandbox_cleanup_at', to_jsonb(now()),
--       'sandbox_cleanup_reason', 'spurious_auto_checkout_pre_fix'
--     )
--   )
-- WHERE bs.id IN (
--   'REPLACE_SUBSCRIPTION_UUID'::uuid
-- )
--   AND bs.provider = 'asaas'
--   AND lower(trim(coalesce(bs.status, ''))) = 'pending';

-- REVISE o resultado acima. Se estiver correto:
COMMIT;
-- Se algo estiver errado:
-- ROLLBACK;
