-- ======================================================================
-- S7 | P0.3-C.1M3 — Pending manual review com billing cycle indeterminável
--
-- Expand-first: cycle_key nullable para PENDING/FINAL sem ciclo conhecido.
-- Order identity estável; ciclo comercial pode ser resolvido depois.
--
-- PROD-safe: termina sem GRANT service_role.
-- DEV grant: scripts/sql/p0_3c1m3_grant_dev_billing_unresolved_cycle.sql
--
-- Backward compatible com backend 4af0002 (skip unresolved materialization).
-- Não altera migrations C.1M / C.1M2 versionadas.
-- Não modifica rows RF contaminadas (remediation separada).
-- ======================================================================

BEGIN;

-- ------------------------------------------------------------------
-- Pré-expansão: baseline deve permanecer cycle_key preenchido
-- ------------------------------------------------------------------
DO $$
DECLARE
  v_invalid_result bigint;
  v_active_null_cycle bigint;
  v_existing_null bigint;
BEGIN
  SELECT COUNT(*) INTO v_invalid_result
  FROM public.billing_billable_sale_admissions
  WHERE admission_result NOT IN (
    'RESERVED', 'PERSISTED', 'ROLLED_BACK', 'EXPIRED', 'REJECTED_QUOTA',
    'RECOVERY_REQUIRED', 'PENDING_MANUAL_REVIEW', 'FINAL_NOT_BILLABLE'
  );

  IF v_invalid_result > 0 THEN
    RAISE EXCEPTION 'p0_3c1m3: admission_result inesperado antes do expand (=%)', v_invalid_result;
  END IF;

  SELECT COUNT(*) INTO v_active_null_cycle
  FROM public.billing_billable_sale_admissions
  WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
    AND (cycle_key IS NULL OR btrim(cycle_key) = '');

  IF v_active_null_cycle > 0 THEN
    RAISE EXCEPTION 'p0_3c1m3: active admission sem cycle_key (=%)', v_active_null_cycle;
  END IF;

  SELECT COUNT(*) INTO v_existing_null
  FROM public.billing_billable_sale_admissions
  WHERE cycle_key IS NULL;

  IF v_existing_null > 0 THEN
    RAISE EXCEPTION 'p0_3c1m3: cycle_key NULL preexistente (=%)', v_existing_null;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- Metadados de resolução de ciclo (same row, admission_id preservado)
-- ------------------------------------------------------------------
ALTER TABLE public.billing_billable_sale_admissions
  ADD COLUMN IF NOT EXISTS pending_cycle_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_cycle_resolution_reason text;

COMMENT ON COLUMN public.billing_billable_sale_admissions.pending_cycle_resolved_at IS
  'Timestamp da atribuição canônica de cycle_key em pending manual review.';
COMMENT ON COLUMN public.billing_billable_sale_admissions.pending_cycle_resolution_reason IS
  'Motivo/audit trail da resolução de cycle_key (ex.: quota_counting_started_at_materialized).';

ALTER TABLE public.billing_billable_sale_admissions
  ALTER COLUMN cycle_key DROP NOT NULL;

ALTER TABLE public.billing_billable_sale_admissions
  DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_cycle_null_chk;

ALTER TABLE public.billing_billable_sale_admissions
  ADD CONSTRAINT billing_billable_sale_admissions_cycle_null_chk
  CHECK (
    cycle_key IS NOT NULL
    OR admission_result IN ('PENDING_MANUAL_REVIEW', 'FINAL_NOT_BILLABLE')
  );

ALTER TABLE public.billing_billable_sale_admissions
  DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_cycle_required_chk;

ALTER TABLE public.billing_billable_sale_admissions
  ADD CONSTRAINT billing_billable_sale_admissions_cycle_required_chk
  CHECK (
    admission_result NOT IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
    OR (cycle_key IS NOT NULL AND btrim(cycle_key) <> '')
  );

-- ------------------------------------------------------------------
-- Índices: NULL semantics explícitas (PostgreSQL NULL ≠ NULL em unique)
-- ------------------------------------------------------------------
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_active_order_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_idempotency_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_pending_unresolved_order_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_final_unresolved_order_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_idempotency_pending_uidx;

CREATE UNIQUE INDEX billing_billable_sale_admissions_active_order_uidx
  ON public.billing_billable_sale_admissions (
    subscription_id,
    cycle_key,
    marketplace,
    marketplace_account_id,
    external_order_id
  )
  WHERE admission_result IN (
    'RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED',
    'PENDING_MANUAL_REVIEW', 'FINAL_NOT_BILLABLE'
  )
    AND cycle_key IS NOT NULL
    AND btrim(cycle_key) <> ''
    AND marketplace IS NOT NULL
    AND btrim(marketplace) <> ''
    AND marketplace_account_id IS NOT NULL
    AND external_order_id IS NOT NULL
    AND btrim(external_order_id) <> '';

CREATE UNIQUE INDEX billing_billable_sale_admissions_pending_unresolved_order_uidx
  ON public.billing_billable_sale_admissions (
    subscription_id,
    marketplace,
    marketplace_account_id,
    external_order_id
  )
  WHERE admission_result = 'PENDING_MANUAL_REVIEW'
    AND cycle_key IS NULL
    AND marketplace IS NOT NULL
    AND btrim(marketplace) <> ''
    AND marketplace_account_id IS NOT NULL
    AND external_order_id IS NOT NULL
    AND btrim(external_order_id) <> '';

CREATE UNIQUE INDEX billing_billable_sale_admissions_final_unresolved_order_uidx
  ON public.billing_billable_sale_admissions (
    subscription_id,
    marketplace,
    marketplace_account_id,
    external_order_id
  )
  WHERE admission_result = 'FINAL_NOT_BILLABLE'
    AND cycle_key IS NULL
    AND marketplace IS NOT NULL
    AND btrim(marketplace) <> ''
    AND marketplace_account_id IS NOT NULL
    AND external_order_id IS NOT NULL
    AND btrim(external_order_id) <> '';

CREATE UNIQUE INDEX billing_billable_sale_admissions_idempotency_uidx
  ON public.billing_billable_sale_admissions (subscription_id, cycle_key, idempotency_key)
  WHERE admission_result IN (
    'RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED',
    'PENDING_MANUAL_REVIEW', 'FINAL_NOT_BILLABLE'
  )
    AND cycle_key IS NOT NULL
    AND btrim(cycle_key) <> '';

CREATE UNIQUE INDEX billing_billable_sale_admissions_idempotency_pending_uidx
  ON public.billing_billable_sale_admissions (subscription_id, idempotency_key)
  WHERE admission_result = 'PENDING_MANUAL_REVIEW'
    AND cycle_key IS NULL;

-- ------------------------------------------------------------------
-- Idempotency: namespace pending/order (sem cycle inventado)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_internal_build_pending_manual_review_idempotency_key(
  p_subscription_id uuid,
  p_marketplace text,
  p_marketplace_account_id uuid,
  p_external_order_id text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'pending_manual_review:'
    || p_subscription_id::text || ':'
    || COALESCE(p_marketplace, '') || ':'
    || COALESCE(p_marketplace_account_id::text, '') || ':'
    || p_external_order_id;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_is_forbidden_cycle_sentinel(p_cycle_key text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    lower(btrim(COALESCE(p_cycle_key, ''))) IN (
      'unresolved', 'unknown', 'pending', 'temp', 'current-month'
    ),
    false
  );
$$;

-- ------------------------------------------------------------------
-- Upsert v2 — aceita cycle_key NULL; v1 permanece intacto
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_upsert_manual_review_pending_v2(
  p_user_id uuid,
  p_subscription_id uuid,
  p_cycle_key text,
  p_external_order_id text,
  p_marketplace text,
  p_marketplace_account_id uuid,
  p_period_class text DEFAULT NULL,
  p_classification_reason text DEFAULT NULL,
  p_snapshot_origin text DEFAULT NULL,
  p_official_order_at timestamptz DEFAULT NULL,
  p_next_recovery_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_origin text := lower(btrim(COALESCE(p_snapshot_origin, '')));
  v_cycle text := NULLIF(btrim(COALESCE(p_cycle_key, '')), '');
  v_idempotency text;
  v_existing_id uuid;
  v_existing_result text;
  v_existing_cycle text;
  v_new_id uuid;
  v_slot_count integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_subscription_id IS NULL
     OR p_external_order_id IS NULL OR btrim(p_external_order_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  IF p_marketplace IS NULL OR btrim(p_marketplace) = '' OR p_marketplace_account_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete_marketplace_identity');
  END IF;

  IF public.billing_internal_is_forbidden_cycle_sentinel(v_cycle) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden_cycle_sentinel');
  END IF;

  IF v_cycle IS NOT NULL AND v_origin NOT IN ('onboarding_import', 'historical_import') THEN
    NULL;
  ELSIF v_cycle IS NULL AND v_origin IN ('onboarding_import', 'historical_import') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'historical_import_blocked',
      'process_sale', false
    );
  END IF;

  IF v_origin IN ('onboarding_import', 'historical_import') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'historical_import_blocked',
      'process_sale', false
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.billing_subscriptions bs
    WHERE bs.id = p_subscription_id
      AND bs.user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'subscription_not_found');
  END IF;

  IF NOT public.billing_internal_validate_marketplace_account(
    p_user_id, p_marketplace, p_marketplace_account_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'marketplace_account_invalid');
  END IF;

  IF v_cycle IS NULL THEN
    v_idempotency := public.billing_internal_build_pending_manual_review_idempotency_key(
      p_subscription_id, p_marketplace, p_marketplace_account_id, p_external_order_id
    );
  ELSE
    v_idempotency := public.billing_internal_build_admission_idempotency_key(
      p_subscription_id, v_cycle, p_marketplace, p_marketplace_account_id, p_external_order_id
    );
    v_slot_count := public.billing_count_active_billable_slots(p_subscription_id, v_cycle);
  END IF;

  SELECT a.id, a.admission_result, a.cycle_key
  INTO v_existing_id, v_existing_result, v_existing_cycle
  FROM public.billing_billable_sale_admissions a
  WHERE a.subscription_id = p_subscription_id
    AND a.marketplace = p_marketplace
    AND a.marketplace_account_id = p_marketplace_account_id
    AND a.external_order_id = p_external_order_id
    AND a.admission_result IN (
      'PENDING_MANUAL_REVIEW', 'RESERVED', 'PERSISTED',
      'RECOVERY_REQUIRED', 'FINAL_NOT_BILLABLE'
    )
  ORDER BY
    CASE a.admission_result
      WHEN 'PERSISTED' THEN 1
      WHEN 'RESERVED' THEN 2
      WHEN 'RECOVERY_REQUIRED' THEN 3
      WHEN 'FINAL_NOT_BILLABLE' THEN 4
      WHEN 'PENDING_MANUAL_REVIEW' THEN 5
      ELSE 99
    END
  LIMIT 1
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    IF v_existing_result = 'PENDING_MANUAL_REVIEW' THEN
      UPDATE public.billing_billable_sale_admissions
      SET period_class = COALESCE(NULLIF(btrim(p_period_class), ''), period_class),
          classification_reason = COALESCE(NULLIF(btrim(p_classification_reason), ''), classification_reason),
          snapshot_origin = COALESCE(NULLIF(btrim(p_snapshot_origin), ''), snapshot_origin),
          official_order_at = COALESCE(p_official_order_at, official_order_at),
          next_recovery_at = COALESCE(p_next_recovery_at, next_recovery_at, v_now),
          updated_at = v_now
      WHERE id = v_existing_id;

      RETURN jsonb_build_object(
        'ok', true,
        'created', false,
        'duplicate', true,
        'admission_id', v_existing_id,
        'admission_result', v_existing_result,
        'cycle_key', v_existing_cycle,
        'cycle_unresolved', v_existing_cycle IS NULL,
        'usage_count', CASE
          WHEN v_existing_cycle IS NULL THEN 0
          ELSE public.billing_count_active_billable_slots(p_subscription_id, v_existing_cycle)
        END,
        'reason', 'pending_already_exists'
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'duplicate', true,
      'admission_id', v_existing_id,
      'admission_result', v_existing_result,
      'usage_count', CASE
        WHEN v_existing_cycle IS NULL THEN 0
        ELSE public.billing_count_active_billable_slots(p_subscription_id, v_existing_cycle)
      END,
      'reason', CASE v_existing_result
        WHEN 'FINAL_NOT_BILLABLE' THEN 'final_not_billable_exists'
        WHEN 'PERSISTED' THEN 'already_persisted'
        WHEN 'RESERVED' THEN 'reservation_in_progress'
        WHEN 'RECOVERY_REQUIRED' THEN 'recovery_in_progress'
        ELSE 'active_admission_exists'
      END
    );
  END IF;

  INSERT INTO public.billing_billable_sale_admissions (
    user_id,
    subscription_id,
    cycle_key,
    external_order_id,
    marketplace,
    marketplace_account_id,
    admission_result,
    idempotency_key,
    period_class,
    classification_reason,
    snapshot_origin,
    official_order_at,
    recovery_reason,
    next_recovery_at,
    recovery_attempt_count,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_subscription_id,
    v_cycle,
    p_external_order_id,
    p_marketplace,
    p_marketplace_account_id,
    'PENDING_MANUAL_REVIEW',
    v_idempotency,
    NULLIF(btrim(p_period_class), ''),
    NULLIF(btrim(p_classification_reason), ''),
    NULLIF(btrim(p_snapshot_origin), ''),
    p_official_order_at,
    COALESCE(NULLIF(btrim(p_classification_reason), ''), 'manual_review_pending'),
    COALESCE(p_next_recovery_at, v_now),
    0,
    v_now,
    v_now
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'ok', true,
    'created', true,
    'duplicate', false,
    'admission_id', v_new_id,
    'admission_result', 'PENDING_MANUAL_REVIEW',
    'cycle_key', v_cycle,
    'cycle_unresolved', v_cycle IS NULL,
    'usage_count', v_slot_count,
    'idempotency_key', v_idempotency
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT a.id, a.admission_result, a.cycle_key
    INTO v_existing_id, v_existing_result, v_existing_cycle
    FROM public.billing_billable_sale_admissions a
    WHERE a.subscription_id = p_subscription_id
      AND (
        a.idempotency_key = v_idempotency
        OR (
          a.marketplace = p_marketplace
          AND a.marketplace_account_id = p_marketplace_account_id
          AND a.external_order_id = p_external_order_id
        )
      )
      AND a.admission_result IN (
        'PENDING_MANUAL_REVIEW', 'RESERVED', 'PERSISTED',
        'RECOVERY_REQUIRED', 'FINAL_NOT_BILLABLE'
      )
    LIMIT 1;

    RETURN jsonb_build_object(
      'ok', COALESCE(v_existing_result = 'PENDING_MANUAL_REVIEW', false),
      'created', false,
      'duplicate', true,
      'admission_id', v_existing_id,
      'admission_result', v_existing_result,
      'cycle_key', v_existing_cycle,
      'usage_count', CASE
        WHEN v_existing_cycle IS NULL THEN 0
        ELSE public.billing_count_active_billable_slots(p_subscription_id, v_existing_cycle)
      END,
      'reason', 'unique_violation_existing'
    );
END;
$$;

-- ------------------------------------------------------------------
-- Resolve cycle — same row; não reserva quota; idempotente
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_resolve_pending_cycle_v1(
  p_user_id uuid,
  p_admission_id uuid,
  p_cycle_key text,
  p_resolution_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_target_cycle text := NULLIF(btrim(COALESCE(p_cycle_key, '')), '');
  v_new_idempotency text;
  v_now timestamptz := now();
BEGIN
  IF p_user_id IS NULL OR p_admission_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  IF v_target_cycle IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_cycle_key');
  END IF;

  IF public.billing_internal_is_forbidden_cycle_sentinel(v_target_cycle) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden_cycle_sentinel');
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

  IF v_row.admission_result IS DISTINCT FROM 'PENDING_MANUAL_REVIEW' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'pending_not_found_or_not_pending',
      'admission_result', v_row.admission_result
    );
  END IF;

  IF v_row.cycle_key IS NOT NULL AND btrim(v_row.cycle_key) <> '' THEN
    IF v_row.cycle_key = v_target_cycle THEN
      RETURN jsonb_build_object(
        'ok', true,
        'duplicate', true,
        'resolved', false,
        'reason', 'cycle_already_resolved',
        'admission_id', v_row.id,
        'admission_result', v_row.admission_result,
        'cycle_key', v_row.cycle_key
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'cycle_mismatch',
      'admission_id', v_row.id,
      'existing_cycle_key', v_row.cycle_key,
      'requested_cycle_key', v_target_cycle
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.billing_billable_sale_admissions a
    WHERE a.subscription_id = v_row.subscription_id
      AND a.cycle_key = v_target_cycle
      AND a.marketplace = v_row.marketplace
      AND a.marketplace_account_id = v_row.marketplace_account_id
      AND a.external_order_id = v_row.external_order_id
      AND a.admission_result IN (
        'RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED', 'FINAL_NOT_BILLABLE'
      )
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'active_admission_blocks_resolve',
      'cycle_key', v_target_cycle
    );
  END IF;

  v_new_idempotency := public.billing_internal_build_admission_idempotency_key(
    v_row.subscription_id,
    v_target_cycle,
    v_row.marketplace,
    v_row.marketplace_account_id,
    v_row.external_order_id
  );

  UPDATE public.billing_billable_sale_admissions
  SET cycle_key = v_target_cycle,
      idempotency_key = v_new_idempotency,
      pending_cycle_resolved_at = v_now,
      pending_cycle_resolution_reason = COALESCE(NULLIF(btrim(p_resolution_reason), ''), pending_cycle_resolution_reason),
      updated_at = v_now
  WHERE id = v_row.id
    AND admission_result = 'PENDING_MANUAL_REVIEW'
    AND cycle_key IS NULL
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'resolve_lost_race');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'resolved', true,
    'reason', 'cycle_resolved',
    'admission_id', v_row.id,
    'admission_result', v_row.admission_result,
    'cycle_key', v_row.cycle_key,
    'usage_count', public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key)
  );
END;
$$;

-- ------------------------------------------------------------------
-- C.1M2 promote — bloqueio explícito cycle_unresolved
-- ------------------------------------------------------------------
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

  IF v_row.cycle_key IS NULL OR btrim(v_row.cycle_key) = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'cycle_unresolved',
      'process_sale', false,
      'admission_id', v_row.id,
      'admission_result', v_row.admission_result
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

COMMENT ON FUNCTION public.billing_upsert_manual_review_pending_v2 IS
  'P0.3-C.1M3 — materializa pending manual review; cycle_key NULL = ciclo indeterminável.';

COMMENT ON FUNCTION public.billing_resolve_pending_cycle_v1 IS
  'P0.3-C.1M3 — atribui cycle canônico na mesma row pending; idempotente; zero quota.';

COMMENT ON FUNCTION public.billing_internal_build_pending_manual_review_idempotency_key IS
  'P0.3-C.1M3 — idempotency por order identity quando cycle_key ainda é NULL.';

DO $$
BEGIN
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_upsert_manual_review_pending_v2(
      uuid, uuid, text, text, text, uuid, text, text, text, timestamptz, timestamptz
    ) FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_resolve_pending_cycle_v1(
      uuid, uuid, text, text
    ) FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_internal_build_pending_manual_review_idempotency_key(
      uuid, text, uuid, text
    ) FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_internal_is_forbidden_cycle_sentinel(text)
    FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
END $$;

COMMIT;
