-- P0.3-C.1M3 — assertions SQL S1–S12 (ROLLBACK — não persiste fixtures)
BEGIN;

DO $$
DECLARE
  v_user uuid := '7f85f0fb-a058-4dc1-9e01-09a9bdc923cc';
  v_sub uuid := '56a32441-b4ec-4de2-8657-0b237b8e4c15';
  v_acct uuid := '359327e4-9902-4213-a1c3-1de702ef92ee';
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_order text := 'P0_3C1M3_' || v_suffix;
  v_cycle text := '2026-08-p0_3c1m3-' || v_suffix;
  v_r1 jsonb;
  v_r2 jsonb;
  v_r3 jsonb;
  v_r4 jsonb;
  v_r5 jsonb;
  v_promote jsonb;
  v_pending uuid;
  v_slots integer;
BEGIN
  -- S1: pending unresolved insert
  v_r1 := public.billing_upsert_manual_review_pending_v2(
    v_user, v_sub, NULL, v_order,
    'mercado_livre', v_acct,
    'MANUAL_REVIEW', 'quota_counting_started_at_missing',
    'operational_sync', now(), now()
  );
  IF COALESCE(v_r1->>'created', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S1 fail: %', v_r1;
  END IF;
  IF COALESCE(v_r1->>'cycle_unresolved', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S1 cycle_unresolved expected: %', v_r1;
  END IF;
  v_pending := (v_r1->>'admission_id')::uuid;

  -- S2: same sale unresolved 2x → one row
  v_r2 := public.billing_upsert_manual_review_pending_v2(
    v_user, v_sub, NULL, v_order,
    'mercado_livre', v_acct,
    'MANUAL_REVIEW', 'quota_counting_started_at_missing',
    'operational_sync', now(), now()
  );
  IF (SELECT COUNT(*) FROM public.billing_billable_sale_admissions
      WHERE subscription_id = v_sub AND external_order_id = v_order
        AND admission_result = 'PENDING_MANUAL_REVIEW') <> 1 THEN
    RAISE EXCEPTION 'S2 fail: duplicate pending rows';
  END IF;

  -- S3: pending unresolved = 0 slot
  v_slots := public.billing_count_active_billable_slots(v_sub, v_cycle);
  IF v_slots <> 0 THEN
    RAISE EXCEPTION 'S3 fail: slot=%', v_slots;
  END IF;

  -- S7: promote before resolve → blocked
  v_promote := public.billing_promote_manual_review_pending_to_reservation_v1(
    v_user, v_pending, gen_random_uuid(), NULL, false
  );
  IF v_promote->>'reason' IS DISTINCT FROM 'cycle_unresolved' THEN
    RAISE EXCEPTION 'S7 fail: %', v_promote;
  END IF;

  -- S4/S5: resolve NULL→cycle same admission_id; idempotent 2x
  v_r3 := public.billing_resolve_pending_cycle_v1(
    v_user, v_pending, v_cycle, 'test_resolution'
  );
  IF COALESCE(v_r3->>'resolved', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S4 fail: %', v_r3;
  END IF;
  IF (SELECT cycle_key FROM public.billing_billable_sale_admissions WHERE id = v_pending) IS DISTINCT FROM v_cycle THEN
    RAISE EXCEPTION 'S4 fail: cycle not assigned';
  END IF;

  v_r4 := public.billing_resolve_pending_cycle_v1(
    v_user, v_pending, v_cycle, 'test_resolution_repeat'
  );
  IF v_r4->>'reason' IS DISTINCT FROM 'cycle_already_resolved' THEN
    RAISE EXCEPTION 'S5 fail: %', v_r4;
  END IF;

  -- S6: conflicting cycle blocked
  v_r5 := public.billing_resolve_pending_cycle_v1(
    v_user, v_pending, v_cycle || '-other', 'conflict_probe'
  );
  IF v_r5->>'reason' IS DISTINCT FROM 'cycle_mismatch' THEN
    RAISE EXCEPTION 'S6 fail: %', v_r5;
  END IF;

  -- S10: final not billable with NULL cycle
  v_order := 'P0_3C1M3_FINAL_' || v_suffix;
  PERFORM public.billing_upsert_manual_review_pending_v2(
    v_user, v_sub, NULL, v_order,
    'mercado_livre', v_acct,
    'TRIAL_OBSERVADO', 'trial_active_unlimited',
    'operational_sync', now(), now()
  );
  v_pending := (
    SELECT id FROM public.billing_billable_sale_admissions
    WHERE external_order_id = v_order LIMIT 1
  );
  PERFORM public.billing_finalize_manual_review_not_billable_v1(
    v_user, v_pending, 'trial_fixture'
  );
  IF (SELECT cycle_key FROM public.billing_billable_sale_admissions WHERE id = v_pending) IS NOT NULL THEN
    RAISE EXCEPTION 'S10 fail: final should allow NULL cycle';
  END IF;

  -- S11: historical blocked
  IF (public.billing_upsert_manual_review_pending_v2(
    v_user, v_sub, NULL, v_order || '_HIST',
    'mercado_livre', v_acct,
    NULL, NULL, 'onboarding_import', now(), now()
  )->>'reason') IS DISTINCT FROM 'historical_import_blocked' THEN
    RAISE EXCEPTION 'S11 fail: historical must block';
  END IF;

  -- S12: v1 still rejects NULL cycle (backward compat)
  IF (public.billing_upsert_manual_review_pending_v1(
    v_user, v_sub, NULL, v_order || '_V1',
    'mercado_livre', v_acct,
    NULL, NULL, 'operational_sync', now(), now()
  )->>'reason') IS DISTINCT FROM 'invalid_input' THEN
    RAISE EXCEPTION 'S12 fail: v1 invalid_input expected';
  END IF;

  RAISE NOTICE 'P0.3-C.1M3 assertions PASS suffix=%', v_suffix;
END $$;

ROLLBACK;
