-- ======================================================================
-- S7 | P0.3-C.1M — Billing manual review pending (expand-first, DEV→PROD)
--
-- Adiciona estados duráveis:
--   PENDING_MANUAL_REVIEW  — não terminal, zero quota, reconciliável
--   FINAL_NOT_BILLABLE     — terminal, zero quota
--
-- PROD-safe: termina sem GRANT service_role.
-- DEV homolog grant: scripts/sql/p0_3c1m_grant_dev_billing_manual_review_pending.sql
--
-- Backward compatible com backend 8f8aeed (nenhum caller novo até fase C.1).
-- ======================================================================

BEGIN;

-- Metadados comerciais opcionais (reutilizados pelo reconciler futuro)
ALTER TABLE public.billing_billable_sale_admissions
  ADD COLUMN IF NOT EXISTS period_class text,
  ADD COLUMN IF NOT EXISTS classification_reason text,
  ADD COLUMN IF NOT EXISTS snapshot_origin text,
  ADD COLUMN IF NOT EXISTS official_order_at timestamptz;

COMMENT ON COLUMN public.billing_billable_sale_admissions.period_class IS
  'Classificação comercial da venda (ex.: OPERACIONAL, IMPORTACAO_HISTORICA).';
COMMENT ON COLUMN public.billing_billable_sale_admissions.classification_reason IS
  'Motivo da classificação comercial (ex.: quota_counting_started_at_missing).';
COMMENT ON COLUMN public.billing_billable_sale_admissions.snapshot_origin IS
  'Origem do snapshot operacional (ex.: operational_sync, onboarding_import).';
COMMENT ON COLUMN public.billing_billable_sale_admissions.official_order_at IS
  'Data oficial da venda no marketplace (date_created).';

-- Prova pré-expansão: rows existentes permanecem válidas
DO $$
DECLARE
  v_invalid bigint;
BEGIN
  SELECT COUNT(*) INTO v_invalid
  FROM public.billing_billable_sale_admissions
  WHERE admission_result NOT IN (
    'RESERVED', 'PERSISTED', 'ROLLED_BACK', 'EXPIRED',
    'REJECTED_QUOTA', 'RECOVERY_REQUIRED'
  );
  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'p0_3c1m: admission_result inesperado antes do expand (=%)', v_invalid;
  END IF;
END $$;

ALTER TABLE public.billing_billable_sale_admissions
  DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_result_chk;

ALTER TABLE public.billing_billable_sale_admissions
  ADD CONSTRAINT billing_billable_sale_admissions_result_chk
  CHECK (admission_result IN (
    'RESERVED', 'PERSISTED', 'ROLLED_BACK', 'EXPIRED', 'REJECTED_QUOTA',
    'RECOVERY_REQUIRED', 'PENDING_MANUAL_REVIEW', 'FINAL_NOT_BILLABLE'
  ));

-- Unicidade lógica por order/cycle (inclui pending + final terminal)
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_active_order_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_idempotency_uidx;

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
  );

CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_pending_review_idx
  ON public.billing_billable_sale_admissions (next_recovery_at, updated_at)
  WHERE admission_result = 'PENDING_MANUAL_REVIEW';

-- billing_count_active_billable_slots permanece inalterado (PENDING/FINAL não consomem slot).
-- Reservado/persisted/recovery mantêm comportamento 6.9A.10.

CREATE OR REPLACE FUNCTION public.billing_upsert_manual_review_pending_v1(
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
  v_idempotency text;
  v_existing_id uuid;
  v_existing_result text;
  v_new_id uuid;
  v_slot_count integer;
BEGIN
  IF p_user_id IS NULL OR p_subscription_id IS NULL OR p_cycle_key IS NULL
     OR p_external_order_id IS NULL OR btrim(p_external_order_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  IF p_marketplace IS NULL OR btrim(p_marketplace) = '' OR p_marketplace_account_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete_marketplace_identity');
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

  IF v_origin IN ('onboarding_import', 'historical_import') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'historical_import_blocked',
      'process_sale', false
    );
  END IF;

  v_idempotency := public.billing_internal_build_admission_idempotency_key(
    p_subscription_id, p_cycle_key, p_marketplace, p_marketplace_account_id, p_external_order_id
  );

  SELECT a.id, a.admission_result
  INTO v_existing_id, v_existing_result
  FROM public.billing_billable_sale_admissions a
  WHERE a.subscription_id = p_subscription_id
    AND a.cycle_key = p_cycle_key
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

  v_slot_count := public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key);

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
        'usage_count', v_slot_count,
        'reason', 'pending_already_exists'
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'duplicate', true,
      'admission_id', v_existing_id,
      'admission_result', v_existing_result,
      'usage_count', v_slot_count,
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
    p_cycle_key,
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
    'usage_count', v_slot_count,
    'idempotency_key', v_idempotency
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT a.id, a.admission_result
    INTO v_existing_id, v_existing_result
    FROM public.billing_billable_sale_admissions a
    WHERE a.subscription_id = p_subscription_id
      AND a.cycle_key = p_cycle_key
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
      'usage_count', public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key),
      'reason', 'unique_violation_existing'
    );
END;
$$;

COMMENT ON FUNCTION public.billing_upsert_manual_review_pending_v1 IS
  'P0.3-C.1M — materializa pending manual review idempotente; zero consumo de quota.';

DO $$
BEGIN
  BEGIN
    REVOKE ALL ON FUNCTION public.billing_upsert_manual_review_pending_v1(
      uuid, uuid, text, text, text, uuid, text, text, text, timestamptz, timestamptz
    ) FROM PUBLIC, anon, authenticated, service_role;
  EXCEPTION WHEN undefined_function THEN NULL;
  END;
END $$;

COMMIT;
