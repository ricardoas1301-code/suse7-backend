-- =============================================================================
-- RESET CONTROLADO — billing DEV Fase 2 (SOMENTE DEV)
-- Seller: c8a62ec6-cfbe-4ad9-98ea-49fadebeda50
--
-- ANTES: rodar cancelamento Asaas via script Node:
--   node scripts/resetBillingSellerDevPhase2.mjs --user-id=c8a62ec6-cfbe-4ad9-98ea-49fadebeda50 --confirm
--
-- Este SQL é fallback/manual após Asaas limpo. Preferir o script Node (ordem correta).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_user_id uuid := 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50';
  v_now timestamptz := now();
  v_baby_plan_id uuid;
  v_baby_plan_key text;
  v_cycle_start timestamptz;
  v_cycle_end timestamptz;
  v_next_due date;
BEGIN
  -- Plano Baby/internal (billing_required = false)
  SELECT id, plan_key
  INTO v_baby_plan_id, v_baby_plan_key
  FROM public.plans
  WHERE is_active = true
    AND billing_required = false
  ORDER BY sort_order NULLS LAST, plan_key
  LIMIT 1;

  IF v_baby_plan_id IS NULL THEN
    RAISE EXCEPTION 'Nenhum plano Baby/internal (billing_required=false) encontrado em public.plans';
  END IF;

  v_cycle_start := date_trunc('day', v_now AT TIME ZONE 'UTC');
  v_cycle_end := v_cycle_start + interval '1 month' - interval '1 day';
  v_next_due := (v_cycle_start + interval '1 month')::date;

  -- Ciclos de renovação
  DELETE FROM public.billing_renewal_cycles WHERE user_id = v_user_id;

  -- Pagamentos pendentes/órfãos → canceled (não apaga histórico)
  UPDATE public.billing_payments
  SET
    status = 'canceled',
    updated_at = v_now,
    raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object(
      'dev_reset_phase2_at', v_now,
      'dev_reset_phase2_reason', 'controlled_billing_reset'
    )
  WHERE user_id = v_user_id
    AND lower(coalesce(status, '')) IN (
      'pending', 'pendente', 'awaiting_payment', 'overdue', 'vencido', 'past_due'
    );

  -- Assinaturas Asaas/pagas antigas → canceled
  UPDATE public.billing_subscriptions
  SET
    status = 'canceled',
    canceled_at = coalesce(canceled_at, v_now),
    updated_at = v_now,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'dev_reset_phase2_at', v_now,
      'dev_reset_phase2_reason', 'controlled_billing_reset',
      'delinquency_status', 'none',
      'auto_renew', false
    )
  WHERE user_id = v_user_id
    AND provider <> 'internal';

  -- Assinaturas internal antigas → canceled (será recriada Baby)
  UPDATE public.billing_subscriptions
  SET
    status = 'canceled',
    canceled_at = coalesce(canceled_at, v_now),
    updated_at = v_now
  WHERE user_id = v_user_id
    AND provider = 'internal'
    AND status IN ('active', 'internal_free', 'pending', 'past_due');

  -- Cartões de teste → inativos (opcional para teste limpo)
  UPDATE public.billing_payment_methods
  SET
    status = 'INACTIVE',
    is_default = false,
    updated_at = v_now
  WHERE user_id = v_user_id
    AND status = 'ACTIVE';

  -- Nova assinatura Baby/internal
  INSERT INTO public.billing_subscriptions (
    user_id,
    plan_id,
    plan_key,
    provider,
    provider_customer_id,
    provider_subscription_id,
    status,
    amount,
    currency,
    current_period_start,
    current_period_end,
    next_due_date,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    v_user_id,
    v_baby_plan_id,
    v_baby_plan_key,
    'internal',
    'internal',
    NULL,
    'internal_free',
    0,
    'BRL',
    v_cycle_start,
    v_cycle_end,
    v_next_due,
    jsonb_build_object(
      'plan_key', v_baby_plan_key,
      'source', 'dev_reset_phase2',
      'internal', true,
      'auto_renew', false,
      'billing_cycle_anchor', v_cycle_start
    ),
    v_now,
    v_now
  );
END $$;

COMMIT;

-- Validar pós-reset
SELECT id, status, plan_key, provider, current_period_start, current_period_end, next_due_date, created_at
FROM public.billing_subscriptions
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
ORDER BY created_at DESC
LIMIT 5;
