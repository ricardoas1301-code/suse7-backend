-- =============================================================================
-- DIAGNÓSTICO — reset controlado billing DEV (Fase 2)
-- Seller: c8a62ec6-cfbe-4ad9-98ea-49fadebeda50
-- =============================================================================

-- 1) Assinaturas
SELECT
  id,
  status,
  plan_key,
  plan_id,
  provider,
  provider_customer_id,
  provider_subscription_id,
  current_period_start,
  current_period_end,
  next_due_date,
  amount,
  canceled_at,
  created_at,
  updated_at,
  metadata->>'payment_method' AS payment_method,
  metadata->>'delinquency_status' AS delinquency_status,
  metadata->>'plan_change_target_plan_slug' AS plan_change_target
FROM public.billing_subscriptions
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
ORDER BY created_at DESC;

-- 2) Pagamentos
SELECT
  p.id,
  p.status,
  p.provider,
  p.provider_payment_id,
  p.subscription_id,
  s.plan_key,
  p.amount,
  p.paid_at,
  p.event_type_snapshot,
  p.raw_payload->>'dueDate' AS due_date,
  p.raw_payload->>'billingType' AS billing_type,
  p.created_at,
  p.updated_at
FROM public.billing_payments p
LEFT JOIN public.billing_subscriptions s ON s.id = p.subscription_id
WHERE p.user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
ORDER BY p.created_at DESC
LIMIT 100;

-- 3) Ciclos de renovação (Fase 2)
SELECT
  id,
  subscription_id,
  current_plan_key,
  renewal_strategy,
  renewal_status,
  renewal_due_date,
  cycle_start,
  cycle_end,
  generated_payment_id,
  provider_payment_id,
  auto_charge_status,
  retry_count,
  grace_period_until,
  created_at,
  updated_at
FROM public.billing_renewal_cycles
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
ORDER BY created_at DESC;

-- 4) Formas de pagamento salvas
SELECT
  id,
  provider,
  method_type,
  card_type,
  brand,
  last4,
  is_default,
  supports_auto_renew,
  status,
  created_at
FROM public.billing_payment_methods
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
ORDER BY created_at DESC;

-- 5) Cliente billing (gateway)
SELECT id, provider, provider_customer_id, email, created_at
FROM public.billing_customers
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50';

-- 6) Resumo
SELECT
  (SELECT count(*) FROM public.billing_subscriptions WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50') AS subs_total,
  (SELECT count(*) FROM public.billing_subscriptions WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50' AND status IN ('active', 'pending', 'past_due', 'internal_free')) AS subs_open,
  (SELECT count(*) FROM public.billing_payments WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50' AND lower(coalesce(status, '')) IN ('pending', 'overdue', 'past_due', 'awaiting_payment')) AS payments_pending,
  (SELECT count(*) FROM public.billing_renewal_cycles WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50') AS renewal_cycles_total;
