-- =============================================================================
-- S7 BILLING — DIAGNÓSTICO (somente leitura)
-- Cobranças pendentes suspeitas no sandbox / usuário de teste
--
-- ANTES DE RODAR:
-- 1) Substitua o filtro do usuário na CTE target_user (email OU user_id).
-- 2) Rode apenas SELECT — não há UPDATE/DELETE neste arquivo.
-- 3) Use o script Node para cancelar no Asaas antes de qualquer UPDATE local.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CONFIGURAÇÃO — edite UMA das linhas abaixo
-- -----------------------------------------------------------------------------
-- Por e-mail:
--   WHERE lower(u.email) = lower('seu-usuario-teste@exemplo.com')
-- Por user_id:
--   WHERE u.id = '00000000-0000-0000-0000-000000000000'::uuid

WITH target_user AS (
  SELECT u.id AS user_id, u.email
  FROM auth.users u
  WHERE lower(u.email) = lower('REPLACE_WITH_TEST_EMAIL@example.com')
  LIMIT 1
),

pending_payment_status AS (
  SELECT unnest(ARRAY[
    'pending',
    'pendente',
    'awaiting_payment',
    'overdue',
    'vencido',
    'past_due'
  ]) AS status_norm
),

paid_payment_status AS (
  SELECT unnest(ARRAY[
    'paid',
    'pago',
    'received',
    'confirmed',
    'received_in_cash'
  ]) AS status_norm
)

-- -----------------------------------------------------------------------------
-- 1) Cobranças pendentes / suspeitas (foco principal)
-- -----------------------------------------------------------------------------
SELECT
  'pending_payments' AS section,
  bp.id AS payment_internal_id,
  bp.provider_payment_id AS asaas_payment_id,
  bs.provider_subscription_id AS asaas_subscription_id,
  COALESCE(bs.plan_key, p.plan_key, p.slug) AS plan_key,
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
  bs.id AS subscription_internal_id,
  bs.status AS subscription_status,
  bp.event_type_snapshot,
  tu.email AS user_email
FROM billing_payments bp
INNER JOIN target_user tu ON tu.user_id = bp.user_id
LEFT JOIN billing_subscriptions bs ON bs.id = bp.subscription_id
LEFT JOIN public.plans p ON p.id = bs.plan_id
WHERE bp.provider = 'asaas'
  AND lower(trim(coalesce(bp.status, ''))) IN (SELECT status_norm FROM pending_payment_status)
  AND lower(trim(coalesce(bp.status, ''))) NOT IN (SELECT status_norm FROM paid_payment_status)
ORDER BY bp.created_at DESC;

-- -----------------------------------------------------------------------------
-- 2) Assinaturas Asaas pendentes (checkout abandonado — referência)
-- -----------------------------------------------------------------------------
-- SELECT
--   'pending_subscriptions' AS section,
--   bs.id AS subscription_internal_id,
--   bs.provider_subscription_id AS asaas_subscription_id,
--   COALESCE(bs.plan_key, p.plan_key, p.slug) AS plan_key,
--   COALESCE(NULLIF(trim(bs.metadata->>'payment_method'), ''), '') AS payment_method,
--   bs.amount,
--   bs.status,
--   bs.next_due_date AS due_date,
--   bs.created_at,
--   bs.updated_at,
--   tu.email AS user_email
-- FROM billing_subscriptions bs
-- INNER JOIN target_user tu ON tu.user_id = bs.user_id
-- LEFT JOIN public.plans p ON p.id = bs.plan_id
-- WHERE bs.provider = 'asaas'
--   AND lower(trim(coalesce(bs.status, ''))) = 'pending'
-- ORDER BY bs.created_at DESC;

-- -----------------------------------------------------------------------------
-- 3) Resumo por plano (quantas pendentes por plan_key)
-- -----------------------------------------------------------------------------
-- SELECT
--   COALESCE(bs.plan_key, p.plan_key, p.slug, '(sem plano)') AS plan_key,
--   count(*) AS pending_count,
--   min(bp.created_at) AS oldest_created_at,
--   max(bp.created_at) AS newest_created_at
-- FROM billing_payments bp
-- INNER JOIN target_user tu ON tu.user_id = bp.user_id
-- LEFT JOIN billing_subscriptions bs ON bs.id = bp.subscription_id
-- LEFT JOIN public.plans p ON p.id = bs.plan_id
-- WHERE bp.provider = 'asaas'
--   AND lower(trim(coalesce(bp.status, ''))) IN (SELECT status_norm FROM pending_payment_status)
-- GROUP BY 1
-- ORDER BY pending_count DESC, plan_key;
