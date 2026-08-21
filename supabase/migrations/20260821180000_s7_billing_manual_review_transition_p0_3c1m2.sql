-- ======================================================================
-- S7 | P0.3-C.1M2 — Transição atômica manual review pending
--
-- PENDING_MANUAL_REVIEW → RESERVED (mesma row, quota real)
-- PENDING_MANUAL_REVIEW → FINAL_NOT_BILLABLE (terminal, zero quota)
--
-- PROD-safe: termina sem GRANT service_role.
-- DEV grant: scripts/sql/p0_3c1m2_grant_dev_billing_manual_review_transition.sql
--
-- Backward compatible com backend 8f8aeed e migration C.1M aplicada.
-- Não altera billing_reserve_billable_sale_v2.
-- ======================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.billing_promote_manual_review_pending_to_reservation_v1(
  p_user_id uuid,
  p_admission_id uuid,
  p_reservation_owner_token uuid,
  p_usage_limit integer DEFAULT NULL,
  p_simulate_tx_failure boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_meta jsonb;
  v_prec jsonb;
  v_ctx jsonb;
  v_limit integer;
  v_current integer;
  v_actual integer;
  v_audit_position integer;
  v_attempt_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_expires timestamptz := v_now + interval '15 minutes';
  v_sync_state text;
  v_hard_pause_cycle text;
  v_origin text;
  v_existing_owner uuid;
BEGIN
  IF p_user_id IS NULL OR p_admission_id IS NULL OR p_reservation_owner_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input', 'process_sale', false);
  END IF;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admission_not_found', 'process_sale', false);
  END IF;

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = v_row.subscription_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'subscription_not_found', 'process_sale', false);
  END IF;

  v_origin := lower(btrim(COALESCE(v_row.snapshot_origin, '')));
  IF v_origin IN ('onboarding_import', 'historical_import') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'historical_import_not_promotable',
      'process_sale', false
    );
  END IF;

  IF v_row.admission_result = 'PERSISTED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'duplicate', true,
      'reason', 'already_persisted',
      'domain_code', 'ALREADY_RECORDED',
      'process_sale', false,
      'admission_id', v_row.id,
      'admission_result', v_row.admission_result,
      'usage_count', public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key),
      'atomic', true
    );
  END IF;

  IF v_row.admission_result = 'FINAL_NOT_BILLABLE' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'duplicate', true,
      'reason', 'final_not_billable_terminal',
      'process_sale', false,
      'admission_id', v_row.id,
      'admission_result', v_row.admission_result
    );
  END IF;

  IF v_row.admission_result = 'RECOVERY_REQUIRED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'recovery_in_progress',
      'process_sale', false,
      'admission_id', v_row.id,
      'admission_result', v_row.admission_result,
      'usage_count', public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key),
      'atomic', true
    );
  END IF;

  IF v_row.admission_result = 'RESERVED' THEN
    IF v_row.reservation_owner_token = p_reservation_owner_token THEN
      UPDATE public.billing_billable_sale_admissions
      SET reservation_heartbeat_at = v_now,
          reservation_expires_at = v_expires,
          updated_at = v_now
      WHERE id = v_row.id;

      v_limit := COALESCE(v_row.usage_limit, v_row.cycle_limit_snapshot);
      RETURN jsonb_build_object(
        'ok', true,
        'promoted', false,
        'duplicate', true,
        'reason', 'reservation_reused',
        'process_sale', true,
        'admission_id', v_row.id,
        'admission_result', 'RESERVED',
        'reservation_id', v_row.id,
        'usage_count', public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key),
        'usage_limit', v_limit,
        'atomic', true
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'reservation_in_progress',
      'process_sale', false,
      'admission_id', v_row.id,
      'admission_result', 'RESERVED',
      'usage_count', public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key),
      'atomic', true
    );
  END IF;

  IF v_row.admission_result IS DISTINCT FROM 'PENDING_MANUAL_REVIEW' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'pending_not_found_or_not_pending',
      'admission_result', v_row.admission_result,
      'process_sale', false
    );
  END IF;

  v_prec := public.billing_internal_resolve_access_precedence(v_meta);
  IF NOT COALESCE((v_prec->>'allow_process_sale')::boolean, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', v_prec->>'reason',
      'domain_code', v_prec->>'domain_code',
      'process_sale', false
    );
  END IF;

  IF COALESCE(v_meta->>'trial_state', '') IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'trial_active_not_promotable',
      'process_sale', false
    );
  END IF;

  PERFORM public.billing_internal_materialize_open_cycle_sales_limit_snapshot(v_row.subscription_id);

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = v_row.subscription_id
    AND user_id = p_user_id;

  v_ctx := public.billing_internal_resolve_baby_admission_context(
    p_user_id, v_row.subscription_id, v_row.cycle_key, p_usage_limit
  );
  v_limit := (v_ctx->>'usage_limit')::integer;

  v_sync_state := COALESCE(v_meta->>'sync_state', 'FULL');
  v_hard_pause_cycle := COALESCE(v_meta->>'hard_pause_cycle_key', '');

  IF v_sync_state = 'HARD_PAUSED' AND v_hard_pause_cycle = v_row.cycle_key THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'hard_paused',
      'domain_code', 'BABY_HARD_LIMIT_REACHED',
      'process_sale', false,
      'usage_count', public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key),
      'usage_limit', v_limit
    );
  END IF;

  v_current := public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key);
  IF v_current >= v_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'baby_hard_limit_reached',
      'domain_code', 'BABY_HARD_LIMIT_REACHED',
      'process_sale', false,
      'usage_count', v_current,
      'usage_limit', v_limit,
      'admission_id', v_row.id,
      'admission_result', 'PENDING_MANUAL_REVIEW'
    );
  END IF;

  IF p_simulate_tx_failure THEN
    RAISE EXCEPTION 'billing_promote_simulated_failure' USING ERRCODE = 'P0001';
  END IF;

  v_audit_position := v_current + 1;

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'RESERVED',
      usage_count_after = v_audit_position,
      usage_limit = v_limit,
      cycle_limit_snapshot = v_limit,
      entitlement_type = v_ctx->>'entitlement_type',
      entitlement_source = v_ctx->>'entitlement_source',
      reservation_owner_token = p_reservation_owner_token,
      reservation_attempt_id = v_attempt_id,
      reserved_at = v_now,
      reservation_expires_at = v_expires,
      reservation_heartbeat_at = v_now,
      rolled_back_at = NULL,
      expired_at = NULL,
      persisted_at = NULL,
      finalized_at = NULL,
      recovery_attempt_count = 0,
      last_recovery_at = NULL,
      next_recovery_at = NULL,
      recovery_reason = NULL,
      last_error_code = NULL,
      updated_at = v_now
  WHERE id = v_row.id
    AND admission_result = 'PENDING_MANUAL_REVIEW'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'promote_lost_race', 'process_sale', false);
  END IF;

  v_actual := public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key);
  v_meta := public.billing_internal_sync_subscription_usage_count(
    v_row.subscription_id, v_row.cycle_key, v_meta, v_now
  );

  RETURN jsonb_build_object(
    'ok', true,
    'promoted', true,
    'duplicate', false,
    'reason', CASE WHEN v_actual >= v_limit THEN 'baby_last_slot' ELSE 'baby_within_limit' END,
    'process_sale', true,
    'admission_id', v_row.id,
    'admission_result', 'RESERVED',
    'reservation_id', v_row.id,
    'usage_count', v_actual,
    'usage_limit', v_limit,
    'reservation_expires_at', v_expires,
    'atomic', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_finalize_manual_review_not_billable_v1(
  p_user_id uuid,
  p_admission_id uuid,
  p_classification_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_admission_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admission_not_found');
  END IF;

  PERFORM 1
  FROM public.billing_subscriptions bs
  WHERE bs.id = v_row.subscription_id
    AND bs.user_id = p_user_id
  FOR UPDATE;

  IF v_row.admission_result = 'FINAL_NOT_BILLABLE' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'reason', 'final_not_billable_already',
      'admission_id', v_row.id,
      'admission_result', 'FINAL_NOT_BILLABLE'
    );
  END IF;

  IF v_row.admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'active_admission_blocks_finalize',
      'admission_id', v_row.id,
      'admission_result', v_row.admission_result
    );
  END IF;

  IF v_row.admission_result IS DISTINCT FROM 'PENDING_MANUAL_REVIEW' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'pending_not_found_or_not_pending',
      'admission_result', v_row.admission_result
    );
  END IF;

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'FINAL_NOT_BILLABLE',
      classification_reason = COALESCE(NULLIF(btrim(p_classification_reason), ''), classification_reason),
      finalized_at = now(),
      next_recovery_at = NULL,
      recovery_reason = NULL,
      reservation_owner_token = NULL,
      reservation_expires_at = NULL,
      reservation_heartbeat_at = NULL,
      reserved_at = NULL,
      updated_at = now()
  WHERE id = v_row.id
    AND admission_result = 'PENDING_MANUAL_REVIEW'
  RETURNING id INTO v_row.id;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'finalize_lost_race');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'reason', 'finalized_not_billable',
    'admission_id', v_row.id,
    'admission_result', 'FINAL_NOT_BILLABLE'
  );
END;
$$;

COMMENT ON FUNCTION public.billing_promote_manual_review_pending_to_reservation_v1 IS
  'P0.3-C.1M2 — promove pending manual review para RESERVED na mesma row (quota real, lock subscription).';

COMMENT ON FUNCTION public.billing_finalize_manual_review_not_billable_v1 IS
  'P0.3-C.1M2 — finaliza pending manual review como FINAL_NOT_BILLABLE terminal (zero quota).';

DO $$
BEGIN
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_promote_manual_review_pending_to_reservation_v1(
      uuid, uuid, uuid, integer, boolean
    ) FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_finalize_manual_review_not_billable_v1(
      uuid, uuid, text
    ) FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
END $$;

COMMIT;
