-- =============================================================================
-- S7 BILLING — DIAGNÓSTICO: cobranças pendentes de múltiplos planos (mesmo seller)
-- Somente leitura. Não cancela nem apaga dados.
--
-- Uso:
-- 1) Ajuste o filtro em target_user (e-mail ou user_id).
-- 2) Rode a seção 1 para ver cobranças pendentes detalhadas.
-- 3) Rode a seção 2 para ver sellers com 2+ plan_key no mesmo dia (candidatos a limpeza).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CONFIGURAÇÃO
-- -----------------------------------------------------------------------------
WITH target_user AS (
  SELECT u.id AS user_id, u.email
  FROM auth.users u
  WHERE lower(u.email) = lower('REPLACE_WITH_TEST_EMAIL@example.com')
  -- WHERE u.id = '00000000-0000-0000-0000-000000000000'::uuid
  LIMIT 1
),

pending_status AS (
  SELECT unnest(ARRAY[
    'pending', 'pendente', 'awaiting_payment', 'overdue', 'vencido', 'past_due'
  ]) AS status_norm
)

-- -----------------------------------------------------------------------------
-- 1) Cobranças pendentes do usuário (detalhe completo)
-- -----------------------------------------------------------------------------
SELECT
  bp.id AS payment_internal_id,
  bp.provider_payment_id AS asaas_payment_id,
  bs.provider_subscription_id AS asaas_subscription_id,
  COALESCE(bs.plan_key, p.plan_key, p.slug) AS plan_key,
  bs.plan_id,
  COALESCE(
    NULLIF(trim(bs.metadata->>'payment_method'), ''),
    NULLIF(trim(bp.raw_payload->>'billingType'), ''),
    NULLIF(trim(bp.raw_payload->>'paymentMethod'), '')
  ) AS payment_method,
  bp.amount,
  bp.status,
  COALESCE(
    NULLIF(trim(bp.raw_payload->>'dueDate'), ''),
    NULLIF(trim(bp.raw_payload->>'originalDueDate'), ''),
    bs.next_due_date::text
  ) AS due_date,
  bp.created_at,
  bp.updated_at,
  bp.event_type_snapshot AS billing_reason,
  COALESCE(
    NULLIF(trim(bp.raw_payload->>'description'), ''),
    NULLIF(trim(bs.metadata->>'source'), '')
  ) AS charge_source_hint,
  tu.email AS user_email
FROM billing_payments bp
INNER JOIN target_user tu ON tu.user_id = bp.user_id
LEFT JOIN billing_subscriptions bs ON bs.id = bp.subscription_id
LEFT JOIN public.plans p ON p.id = bs.plan_id
WHERE bp.provider = 'asaas'
  AND lower(trim(coalesce(bp.status, ''))) IN (SELECT status_norm FROM pending_status)
ORDER BY bp.created_at DESC;

-- -----------------------------------------------------------------------------
-- 2) Sellers com múltiplos plan_key pendentes no mesmo dia (automático / job / testes)
-- -----------------------------------------------------------------------------
-- SELECT
--   bp.user_id,
--   date_trunc('day', bp.created_at AT TIME ZONE 'UTC') AS created_day_utc,
--   count(DISTINCT COALESCE(bs.plan_key, p.plan_key, p.slug)) AS distinct_plan_keys,
--   array_agg(DISTINCT COALESCE(bs.plan_key, p.plan_key, p.slug) ORDER BY COALESCE(bs.plan_key, p.plan_key, p.slug)) AS plan_keys,
--   count(*) AS pending_payment_rows
-- FROM billing_payments bp
-- LEFT JOIN billing_subscriptions bs ON bs.id = bp.subscription_id
-- LEFT JOIN public.plans p ON p.id = bs.plan_id
-- WHERE bp.provider = 'asaas'
--   AND lower(trim(coalesce(bp.status, ''))) IN (SELECT status_norm FROM pending_status)
-- GROUP BY bp.user_id, date_trunc('day', bp.created_at AT TIME ZONE 'UTC')
-- HAVING count(DISTINCT COALESCE(bs.plan_key, p.plan_key, p.slug)) > 1
-- ORDER BY created_day_utc DESC, distinct_plan_keys DESC;

-- -----------------------------------------------------------------------------
-- 3) Assinaturas Asaas por plano (referência para cancelamento manual)
-- -----------------------------------------------------------------------------
-- SELECT
--   bs.id AS subscription_internal_id,
--   bs.provider_subscription_id AS asaas_subscription_id,
--   COALESCE(bs.plan_key, p.plan_key, p.slug) AS plan_key,
--   bs.status,
--   bs.amount,
--   bs.next_due_date,
--   bs.created_at,
--   bs.updated_at,
--   COALESCE(bs.metadata->>'source', '') AS subscription_source
-- FROM billing_subscriptions bs
-- INNER JOIN target_user tu ON tu.user_id = bs.user_id
-- LEFT JOIN public.plans p ON p.id = bs.plan_id
-- WHERE bs.provider = 'asaas'
-- ORDER BY bs.created_at DESC;
