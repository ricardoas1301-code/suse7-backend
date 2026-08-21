-- P0.3-C.1M — assertions SQL (transação com ROLLBACK — não persiste fixture)
BEGIN;

DO $$
DECLARE
  v_user uuid := '7f85f0fb-a058-4dc1-9e01-09a9bdc923cc';
  v_sub uuid := '56a32441-b4ec-4de2-8657-0b237b8e4c15';
  v_acct uuid := '359327e4-9902-4213-a1c3-1de702ef92ee';
  v_cycle text := '2026-08-p0_3c1m-test';
  v_order text := 'P0_3C1M_TEST_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_r1 jsonb;
  v_r2 jsonb;
  v_pending uuid;
  v_slots integer;
BEGIN
  -- A/B: CHECK aceita novos estados via INSERT direto (fixture)
  INSERT INTO public.billing_billable_sale_admissions (
    user_id, subscription_id, cycle_key, external_order_id,
    marketplace, marketplace_account_id, admission_result, idempotency_key,
    next_recovery_at
  ) VALUES (
    v_user, v_sub, v_cycle || '-final', v_order || '-F',
    'mercado_livre', v_acct, 'FINAL_NOT_BILLABLE',
    'test:final:' || v_order, now()
  );

  v_r1 := public.billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle, v_order,
    'mercado_livre', v_acct,
    'OPERACIONAL', 'quota_counting_started_at_missing',
    'operational_sync', now(), now()
  );

  IF COALESCE(v_r1->>'created', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'assert: upsert pending first call must create (=%)', v_r1;
  END IF;

  v_pending := (v_r1->>'admission_id')::uuid;

  v_r2 := public.billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle, v_order,
    'mercado_livre', v_acct,
    'OPERACIONAL', 'quota_counting_started_at_missing',
    'operational_sync', now(), now()
  );

  IF COALESCE(v_r2->>'duplicate', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'assert: upsert pending second call must duplicate (=%)', v_r2;
  END IF;

  IF (SELECT COUNT(*) FROM public.billing_billable_sale_admissions
      WHERE subscription_id = v_sub AND cycle_key = v_cycle
        AND external_order_id = v_order
        AND admission_result = 'PENDING_MANUAL_REVIEW') <> 1 THEN
    RAISE EXCEPTION 'assert: exactly one pending row expected';
  END IF;

  -- D/E: pending + final não contam slot; reserved conta
  INSERT INTO public.billing_billable_sale_admissions (
    user_id, subscription_id, cycle_key, external_order_id,
    marketplace, marketplace_account_id, admission_result, idempotency_key,
    usage_count_after, usage_limit, cycle_limit_snapshot,
    reservation_attempt_id, reserved_at, reservation_expires_at
  ) VALUES (
    v_user, v_sub, v_cycle || '-slot', v_order || '-R',
    'mercado_livre', v_acct, 'RESERVED',
    'test:reserved:' || v_order, 1, 100, 100,
    gen_random_uuid(), now(), now() + interval '15 minutes'
  );

  v_slots := public.billing_count_active_billable_slots(v_sub, v_cycle);
  IF v_slots <> 0 THEN
    RAISE EXCEPTION 'assert: pending cycle slot count must be 0 (=%)', v_slots;
  END IF;

  v_slots := public.billing_count_active_billable_slots(v_sub, v_cycle || '-slot');
  IF v_slots <> 1 THEN
    RAISE EXCEPTION 'assert: reserved cycle slot count must be 1 (=%)', v_slots;
  END IF;

  -- historical block
  IF (public.billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle || '-hist', v_order || '-H',
    'mercado_livre', v_acct,
    NULL, NULL, 'onboarding_import', now(), now()
  )->>'reason') IS DISTINCT FROM 'historical_import_blocked' THEN
    RAISE EXCEPTION 'assert: onboarding_import must be blocked';
  END IF;

  RAISE NOTICE 'P0.3-C.1M assertions PASS order=% pending=%', v_order, v_pending;
END $$;

ROLLBACK;
