-- P0.3-C.1M2 — assertions SQL (ROLLBACK — fixture isolada)
BEGIN;

DO $$
DECLARE
  v_user uuid := '7f85f0fb-a058-4dc1-9e01-09a9bdc923cc';
  v_sub uuid := '56a32441-b4ec-4de2-8657-0b237b8e4c15';
  v_acct uuid := '359327e4-9902-4213-a1c3-1de702ef92ee';
  v_cycle text := '2026-08-p0_3c1m2-test';
  v_order text := 'P0_3C1M2_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  v_order_b text := v_order || '_B';
  v_token uuid := gen_random_uuid();
  v_pending_id uuid;
  v_pending_b uuid;
  v_r1 jsonb;
  v_r2 jsonb;
  v_r3 jsonb;
  v_slots integer;
  v_meta_backup jsonb;
BEGIN
  SELECT metadata INTO v_meta_backup FROM billing_subscriptions WHERE id = v_sub;

  UPDATE billing_subscriptions
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'suspension_fallback_active', true,
    'effective_entitlement', 'BABY_INTERNAL_FREE',
    'quota_counting_started_at', '2026-01-01T00:00:00+00:00',
    'sales_limit_snapshot', 2,
    'usage_limit_cycle_key', v_cycle,
    'sales_limit_snapshot_cycle_key', v_cycle,
    'sales_limit_snapshot_materialized_at', now()
  )
  WHERE id = v_sub;

  -- S1 pending→reserved same row
  v_r1 := billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle, v_order, 'mercado_livre', v_acct,
    'FRANQUIA_ELEGIVEL', 'eligible_fixture', 'operational_sync', now(), now()
  );
  v_pending_id := (v_r1->>'admission_id')::uuid;

  v_r2 := billing_promote_manual_review_pending_to_reservation_v1(
    v_user, v_pending_id, v_token, NULL, false
  );

  IF COALESCE(v_r2->>'promoted', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S1 promote failed: %', v_r2;
  END IF;

  IF (SELECT admission_result FROM billing_billable_sale_admissions WHERE id = v_pending_id) <> 'RESERVED' THEN
    RAISE EXCEPTION 'S1 state not RESERVED';
  END IF;

  v_slots := billing_count_active_billable_slots(v_sub, v_cycle);
  IF v_slots <> 1 THEN
    RAISE EXCEPTION 'S1 slot count expected 1 got %', v_slots;
  END IF;

  -- S2 promote again idempotent
  v_r3 := billing_promote_manual_review_pending_to_reservation_v1(
    v_user, v_pending_id, v_token, NULL, false
  );
  IF COALESCE(v_r3->>'reason', '') <> 'reservation_reused' THEN
    RAISE EXCEPTION 'S2 expected reservation_reused got %', v_r3;
  END IF;

  v_slots := billing_count_active_billable_slots(v_sub, v_cycle);
  IF v_slots <> 1 THEN
    RAISE EXCEPTION 'S2 slot count drift %', v_slots;
  END IF;

  -- S3 finalize path (new pending)
  v_r1 := billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle, v_order_b, 'mercado_livre', v_acct,
    'MANUAL_REVIEW', 'final_decision', 'operational_sync', now(), now()
  );
  v_pending_b := (v_r1->>'admission_id')::uuid;

  v_r2 := billing_finalize_manual_review_not_billable_v1(
    v_user, v_pending_b, 'commercial_final_not_billable'
  );
  IF COALESCE(v_r2->>'ok', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S3 finalize failed %', v_r2;
  END IF;

  IF billing_count_active_billable_slots(v_sub, v_cycle) <> 1 THEN
    RAISE EXCEPTION 'S3 finalize must not add slot';
  END IF;

  -- S4 finalize idempotent
  v_r3 := billing_finalize_manual_review_not_billable_v1(v_user, v_pending_b, 'repeat');
  IF COALESCE(v_r3->>'duplicate', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'S4 finalize idempotent failed %', v_r3;
  END IF;

  -- historical guard
  v_r1 := billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle || '-hist', v_order || 'H', 'mercado_livre', v_acct,
    NULL, NULL, 'onboarding_import', now(), now()
  );
  IF (v_r1->>'reason') IS DISTINCT FROM 'historical_import_blocked' THEN
    RAISE EXCEPTION 'historical upsert should block';
  END IF;

  INSERT INTO billing_billable_sale_admissions (
    user_id, subscription_id, cycle_key, external_order_id,
    marketplace, marketplace_account_id, admission_result, idempotency_key,
    snapshot_origin, next_recovery_at
  ) VALUES (
    v_user, v_sub, v_cycle || '-hist2', v_order || 'H2',
    'mercado_livre', v_acct, 'PENDING_MANUAL_REVIEW', 'hist:' || v_order,
    'onboarding_import', now()
  ) RETURNING id INTO v_pending_id;

  v_r2 := billing_promote_manual_review_pending_to_reservation_v1(
    v_user, v_pending_id, gen_random_uuid(), NULL, false
  );
  IF (v_r2->>'reason') IS DISTINCT FROM 'historical_import_not_promotable' THEN
    RAISE EXCEPTION 'historical promote should reject got %', v_r2;
  END IF;

  -- last slot sequential (limit 1): reset cycle limit via metadata
  UPDATE billing_subscriptions
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'suspension_fallback_active', true,
    'effective_entitlement', 'BABY_INTERNAL_FREE',
    'sales_limit_snapshot', 1,
    'usage_limit_cycle_key', v_cycle || '-slot',
    'sales_limit_snapshot_cycle_key', v_cycle || '-slot',
    'sales_limit_snapshot_materialized_at', now()
  )
  WHERE id = v_sub;

  v_r1 := billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle || '-slot', v_order || 'SA', 'mercado_livre', v_acct,
    'FRANQUIA_ELEGIVEL', 'eligible_a', 'operational_sync', now(), now()
  );
  v_r1 := billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle || '-slot', v_order || 'SB', 'mercado_livre', v_acct,
    'FRANQUIA_ELEGIVEL', 'eligible_b', 'operational_sync', now(), now()
  );

  v_pending_id := (billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle || '-slot', v_order || 'SA', 'mercado_livre', v_acct,
    'FRANQUIA_ELEGIVEL', 'eligible_a', 'operational_sync', now(), now()
  )->>'admission_id')::uuid;
  v_pending_b := (billing_upsert_manual_review_pending_v1(
    v_user, v_sub, v_cycle || '-slot', v_order || 'SB', 'mercado_livre', v_acct,
    'FRANQUIA_ELEGIVEL', 'eligible_b', 'operational_sync', now(), now()
  )->>'admission_id')::uuid;

  v_r2 := billing_promote_manual_review_pending_to_reservation_v1(
    v_user, v_pending_id, gen_random_uuid(), NULL, false
  );
  IF COALESCE(v_r2->>'promoted', 'false')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'last slot A failed %', v_r2;
  END IF;

  v_r3 := billing_promote_manual_review_pending_to_reservation_v1(
    v_user, v_pending_b, gen_random_uuid(), NULL, false
  );
  IF (v_r3->>'reason') IS DISTINCT FROM 'baby_hard_limit_reached' THEN
    RAISE EXCEPTION 'last slot B expected quota block got %', v_r3;
  END IF;

  IF billing_count_active_billable_slots(v_sub, v_cycle || '-slot') <> 1 THEN
    RAISE EXCEPTION 'last slot exceeded quota';
  END IF;

  UPDATE billing_subscriptions SET metadata = v_meta_backup WHERE id = v_sub;

  RAISE NOTICE 'P0.3-C.1M2 SQL assertions PASS order=%', v_order;
END $$;

ROLLBACK;
