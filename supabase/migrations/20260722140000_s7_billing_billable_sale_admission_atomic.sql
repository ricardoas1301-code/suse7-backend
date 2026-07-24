-- ======================================================================
-- S7 | Billing — admissão atômica Baby (instalação limpa — S1.HF.6.9A.10)
--
-- Forward-only único: 20260723140000_*_hardening_6_9a10.sql
--
-- Políticas 6.9A.10:
--   precedência canônica de acesso (Node ↔ SQL)
--   data oficial = date_created; ciclo civil America/Sao_Paulo semiaberto
--   baseline por identidade; hard_pause_owner = BABY_QUOTA_ENGINE
--   reserve revalida official_order_at + snapshot_origin
-- ======================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.billing_internal_admission_revoke_execute();
DROP FUNCTION IF EXISTS public.billing_internal_admission_grant_service_role();

CREATE TABLE IF NOT EXISTS public.billing_billable_sale_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  subscription_id uuid NOT NULL REFERENCES public.billing_subscriptions(id) ON DELETE CASCADE,
  cycle_key text NOT NULL,
  external_order_id text NOT NULL,
  marketplace text,
  marketplace_account_id uuid,
  admission_result text NOT NULL,
  usage_count_after integer,
  usage_limit integer,
  entitlement_type text,
  entitlement_source text,
  idempotency_key text NOT NULL,
  pause_applied boolean NOT NULL DEFAULT false,
  pause_cycle_key text,
  pause_reason text,
  previous_sync_state text,
  previous_usage_state text,
  previous_access_profile text,
  reservation_owner_token uuid,
  reservation_attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  reserved_at timestamptz,
  reservation_expires_at timestamptz,
  persisted_at timestamptz,
  finalized_at timestamptz,
  rolled_back_at timestamptz,
  expired_at timestamptz,
  recovery_attempt_count integer NOT NULL DEFAULT 0,
  last_recovery_at timestamptz,
  next_recovery_at timestamptz,
  recovery_reason text,
  reservation_heartbeat_at timestamptz,
  cycle_limit_snapshot integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  CONSTRAINT billing_billable_sale_admissions_result_chk
    CHECK (admission_result IN (
      'RESERVED', 'PERSISTED', 'ROLLED_BACK', 'EXPIRED',
      'REJECTED_QUOTA', 'RECOVERY_REQUIRED'
    ))
);

COMMENT ON TABLE public.billing_billable_sale_admissions IS
  'Reservas/finalizações atômicas Baby — SSOT concorrência (S1.HF.6.9A.4)';

COMMENT ON COLUMN public.billing_billable_sale_admissions.cycle_limit_snapshot IS
  'Limite congelado do ciclo (sales_limit_snapshot) no RESERVE — imutável na admissão.';

COMMENT ON COLUMN public.billing_billable_sale_admissions.reservation_heartbeat_at IS
  'Heartbeat do worker ativo; reconciliador não expira enquanto vigente.';

CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_cycle_active_idx
  ON public.billing_billable_sale_admissions (subscription_id, cycle_key, admission_result);

CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_expires_idx
  ON public.billing_billable_sale_admissions (reservation_expires_at)
  WHERE admission_result = 'RESERVED';

CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_recovery_idx
  ON public.billing_billable_sale_admissions (next_recovery_at)
  WHERE admission_result = 'RECOVERY_REQUIRED';

CREATE UNIQUE INDEX IF NOT EXISTS billing_billable_sale_admissions_active_order_uidx
  ON public.billing_billable_sale_admissions (
    subscription_id,
    cycle_key,
    marketplace,
    marketplace_account_id,
    external_order_id
  )
  WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
    AND marketplace IS NOT NULL
    AND btrim(marketplace) <> ''
    AND marketplace_account_id IS NOT NULL
    AND external_order_id IS NOT NULL
    AND btrim(external_order_id) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS billing_billable_sale_admissions_idempotency_uidx
  ON public.billing_billable_sale_admissions (subscription_id, cycle_key, idempotency_key)
  WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED');

CREATE TABLE IF NOT EXISTS public.billing_internal_deployment_identity (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  environment text NOT NULL,
  project_ref text NOT NULL,
  env_fingerprint text NOT NULL,
  audit_description text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.billing_internal_deployment_identity IS
  'Identidade canônica do ambiente — seed manual DEV; grant DEV consulta esta tabela.';

ALTER TABLE public.billing_internal_deployment_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_internal_deployment_identity FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.billing_billable_sale_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_billable_sale_admissions FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_billable_sale_admissions FROM anon;
REVOKE ALL ON TABLE public.billing_billable_sale_admissions FROM authenticated;

-- ======================================================================
-- Contagem fail-closed: RESERVED sempre ocupa slot até EXPIRED/ROLLED_BACK
-- ======================================================================
CREATE OR REPLACE FUNCTION public.billing_count_active_billable_slots(
  p_subscription_id uuid,
  p_cycle_key text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(COUNT(*)::integer, 0)
  FROM public.billing_billable_sale_admissions
  WHERE subscription_id = p_subscription_id
    AND cycle_key = p_cycle_key
    AND admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED');
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_resolve_baby_admission_context(
  p_user_id uuid,
  p_subscription_id uuid,
  p_cycle_key text,
  p_usage_limit_expected integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_meta jsonb;
  v_canonical_cycle text;
  v_canonical_limit integer;
  v_effective_entitlement text;
  v_fallback_active boolean;
  v_trial_state text;
  v_trial_limit integer;
BEGIN
  SELECT bs.id, bs.user_id, bs.metadata
  INTO v_row
  FROM public.billing_subscriptions bs
  WHERE bs.id = p_subscription_id
    AND bs.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_admission: subscription_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_meta := COALESCE(v_row.metadata, '{}'::jsonb);
  v_fallback_active := COALESCE((v_meta->>'suspension_fallback_active')::boolean, false);
  v_effective_entitlement := COALESCE(v_meta->>'effective_entitlement', '');
  v_trial_state := COALESCE(v_meta->>'trial_state', '');

  IF NOT v_fallback_active OR v_effective_entitlement <> 'BABY_INTERNAL_FREE' THEN
    RAISE EXCEPTION 'billing_admission: baby_entitlement_required' USING ERRCODE = 'P0001';
  END IF;

  IF v_trial_state IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY') THEN
    RAISE EXCEPTION 'billing_admission: trial_not_allowed' USING ERRCODE = 'P0001';
  END IF;

  IF NULLIF(v_meta->>'quota_counting_started_at', '') IS NULL THEN
    RAISE EXCEPTION 'billing_admission: quota_counting_not_started' USING ERRCODE = 'P0001';
  END IF;

  v_canonical_cycle := COALESCE(
    NULLIF(v_meta->>'usage_limit_cycle_key', ''),
    NULLIF(v_meta->>'fallback_period_start', '')
  );

  IF v_canonical_cycle IS NULL OR btrim(v_canonical_cycle) = '' THEN
    RAISE EXCEPTION 'billing_admission: canonical_cycle_missing' USING ERRCODE = 'P0001';
  END IF;

  IF p_cycle_key IS NULL OR btrim(p_cycle_key) = '' OR p_cycle_key <> v_canonical_cycle THEN
    RAISE EXCEPTION 'billing_admission: cycle_key_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF NULLIF(v_meta->>'sales_limit_snapshot_cycle_key', '') IS NULL
     OR btrim(v_meta->>'sales_limit_snapshot_cycle_key') = ''
     OR v_meta->>'sales_limit_snapshot_cycle_key' <> v_canonical_cycle THEN
    RAISE EXCEPTION 'billing_admission: sales_limit_snapshot_cycle_missing_or_mismatch' USING ERRCODE = 'P0001';
  END IF;

  v_canonical_limit := NULLIF(v_meta->>'sales_limit_snapshot', '')::integer;

  IF v_canonical_limit IS NULL OR v_canonical_limit <= 0 THEN
    RAISE EXCEPTION 'billing_admission: sales_limit_snapshot_missing' USING ERRCODE = 'P0001';
  END IF;

  v_trial_limit := NULLIF(v_meta->>'trial_usage_limit', '')::integer;
  IF v_trial_limit IS NOT NULL
     AND v_trial_limit <> v_canonical_limit
     AND p_usage_limit_expected IS NOT NULL
     AND p_usage_limit_expected = v_trial_limit THEN
    RAISE EXCEPTION 'billing_admission: usage_limit_mismatch' USING ERRCODE = 'P0001';
  END IF;

  IF p_usage_limit_expected IS NOT NULL
     AND p_usage_limit_expected > 0
     AND p_usage_limit_expected <> v_canonical_limit THEN
    RAISE EXCEPTION 'billing_admission: usage_limit_mismatch' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'cycle_key', v_canonical_cycle,
    'usage_limit', v_canonical_limit,
    'entitlement_type', 'BABY_INTERNAL_FREE',
    'entitlement_source', COALESCE(v_meta->>'effective_entitlement_source', 'suspension_fallback')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_read_open_cycle_snapshot(
  p_subscription_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb;
  v_cycle text;
  v_limit integer;
BEGIN
  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = p_subscription_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_admission: subscription_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_meta := COALESCE(v_meta, '{}'::jsonb);
  v_cycle := COALESCE(
    NULLIF(v_meta->>'usage_limit_cycle_key', ''),
    NULLIF(v_meta->>'fallback_period_start', '')
  );
  v_limit := NULLIF(v_meta->>'sales_limit_snapshot', '')::integer;

  RETURN jsonb_build_object(
    'cycle_key', v_cycle,
    'sales_limit_snapshot', v_limit,
    'effective_entitlement', COALESCE(v_meta->>'effective_entitlement', ''),
    'suspension_fallback_active', COALESCE((v_meta->>'suspension_fallback_active')::boolean, false)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_build_admission_idempotency_key(
  p_subscription_id uuid,
  p_cycle_key text,
  p_marketplace text,
  p_marketplace_account_id uuid,
  p_external_order_id text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'billable_sale:'
    || p_subscription_id::text || ':'
    || p_cycle_key || ':'
    || COALESCE(p_marketplace, '') || ':'
    || COALESCE(p_marketplace_account_id::text, '') || ':'
    || p_external_order_id;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_read_plan_sales_limit_from_catalog(
  p_plan_key text
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_normalized text := lower(btrim(COALESCE(p_plan_key, '')));
  v_active_count integer;
  v_limit_numeric numeric;
BEGIN
  IF v_normalized IN ('', 'baby_internal_free') THEN
    v_normalized := 'baby';
  END IF;

  IF to_regclass('public.plans') IS NULL THEN
    RAISE EXCEPTION 'billing_admission: plans_catalog_unavailable' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*), MAX(p.sales_limit_monthly)::numeric
  INTO v_active_count, v_limit_numeric
  FROM public.plans p
  WHERE p.plan_key = v_normalized
    AND COALESCE(p.is_active, true);

  IF v_active_count = 0 THEN
    RAISE EXCEPTION 'billing_admission: plan_sales_limit_missing plan_key=%', v_normalized USING ERRCODE = 'P0001';
  END IF;
  IF v_active_count > 1 THEN
    RAISE EXCEPTION 'billing_admission: plan_catalog_ambiguous plan_key=% count=%', v_normalized, v_active_count USING ERRCODE = 'P0001';
  END IF;
  IF v_limit_numeric IS NULL OR v_limit_numeric <= 0 THEN
    RAISE EXCEPTION 'billing_admission: plan_sales_limit_invalid plan_key=%', v_normalized USING ERRCODE = 'P0001';
  END IF;
  IF v_limit_numeric <> trunc(v_limit_numeric) THEN
    RAISE EXCEPTION 'billing_admission: plan_sales_limit_not_integer plan_key=% value=%', v_normalized, v_limit_numeric USING ERRCODE = 'P0001';
  END IF;
  IF v_limit_numeric > 2147483647 THEN
    RAISE EXCEPTION 'billing_admission: plan_sales_limit_out_of_integer_range plan_key=%', v_normalized USING ERRCODE = 'P0001';
  END IF;

  RETURN trunc(v_limit_numeric)::integer;
END;
$$;


-- ======================================================================
-- Precedência + ciclo civil SP (S1.HF.6.9A.10)
-- ======================================================================

CREATE OR REPLACE FUNCTION public.billing_internal_resolve_access_precedence(p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_profile text := COALESCE(v_meta->>'access_profile', 'FULL_ACCESS');
  v_sync text := COALESCE(v_meta->>'sync_state', 'FULL');
  v_owner text := COALESCE(v_meta->>'hard_pause_owner', '');
  v_restriction text := COALESCE(v_meta->>'access_restriction_reason', '');
BEGIN
  IF COALESCE((v_meta->>'security_access_revoked')::boolean, false)
     OR COALESCE((v_meta->>'integration_access_revoked')::boolean, false)
     OR COALESCE((v_meta->>'tenant_disabled')::boolean, false)
     OR v_restriction IN ('SECURITY_REVOKED', 'INTEGRATION_REVOKED', 'TENANT_DISABLED') THEN
    RETURN jsonb_build_object(
      'precedence_rank', 1,
      'reason', 'security_or_revocation',
      'allow_process_sale', false,
      'allow_quota_bypass_trial', false,
      'access_profile', v_profile,
      'sync_state', v_sync
    );
  END IF;

  IF v_profile = 'FINANCIAL_RECOVERY_ONLY' THEN
    RETURN jsonb_build_object(
      'precedence_rank', 2,
      'reason', 'financial_recovery_only',
      'allow_process_sale', false,
      'allow_quota_bypass_trial', false,
      'access_profile', v_profile,
      'sync_state', v_sync
    );
  END IF;

  IF COALESCE((v_meta->>'administrative_hold')::boolean, false)
     OR COALESCE((v_meta->>'data_integrity_hold')::boolean, false)
     OR v_restriction IN ('ADMINISTRATIVE_HOLD', 'DATA_INTEGRITY_HOLD') THEN
    RETURN jsonb_build_object(
      'precedence_rank', 3,
      'reason', 'administrative_or_integrity_hold',
      'allow_process_sale', false,
      'allow_quota_bypass_trial', false,
      'access_profile', v_profile,
      'sync_state', v_sync
    );
  END IF;

  IF v_sync = 'HARD_PAUSED'
     AND (
       v_owner = 'BABY_QUOTA_ENGINE'
       OR (v_owner = '' AND COALESCE(v_meta->>'hard_pause_reason', '') = 'BABY_LIMIT_REACHED')
     ) THEN
    RETURN jsonb_build_object(
      'precedence_rank', 4,
      'reason', 'baby_quota_hard_paused',
      'allow_process_sale', false,
      'allow_quota_bypass_trial', false,
      'access_profile', v_profile,
      'sync_state', v_sync,
      'hard_pause_owner', 'BABY_QUOTA_ENGINE',
      'domain_code', 'BABY_HARD_LIMIT_REACHED'
    );
  END IF;

  IF v_profile IN ('ARCHIVE_READ_ONLY', 'EXECUTIVE_ONLY')
     AND COALESCE(v_meta->>'effective_entitlement', '') = 'PAID_PLAN' THEN
    RETURN jsonb_build_object(
      'precedence_rank', 5,
      'reason', 'paid_usage_restricted',
      'allow_process_sale', false,
      'allow_quota_bypass_trial', false,
      'access_profile', v_profile,
      'sync_state', v_sync
    );
  END IF;

  RETURN jsonb_build_object(
    'precedence_rank', 6,
    'reason', 'trial_or_full_normal',
    'allow_process_sale', true,
    'allow_quota_bypass_trial', true,
    'access_profile', v_profile,
    'sync_state', v_sync
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_civil_instant_sao_paulo(
  p_civil_date date,
  p_end_exclusive boolean DEFAULT false
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_civil_date IS NULL THEN NULL
    WHEN COALESCE(p_end_exclusive, false) THEN
      ((p_civil_date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    ELSE
      (p_civil_date::timestamp AT TIME ZONE 'America/Sao_Paulo')
  END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_resolve_baby_cycle_window(p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_key text;
  v_start date;
  v_end date;
BEGIN
  v_key := COALESCE(NULLIF(v_meta->>'usage_limit_cycle_key', ''), NULLIF(v_meta->>'fallback_period_start', ''));
  BEGIN
    v_start := COALESCE(NULLIF(v_meta->>'fallback_period_start', ''), v_key)::date;
  EXCEPTION WHEN others THEN
    v_start := NULL;
  END;
  BEGIN
    v_end := NULLIF(v_meta->>'fallback_period_end', '')::date;
  EXCEPTION WHEN others THEN
    v_end := NULL;
  END;

  IF v_key IS NULL OR v_start IS NULL OR v_end IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cycle_window_unresolved');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'timezone', 'America/Sao_Paulo',
    'cycle_key', v_key,
    'cycle_started_at', public.billing_internal_civil_instant_sao_paulo(v_start, false),
    'cycle_ends_at_exclusive', public.billing_internal_civil_instant_sao_paulo(v_end, true)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_apply_access_precedence_after_baby_clear(p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_prec jsonb;
BEGIN
  IF COALESCE(v_meta->>'hard_pause_owner', '') = 'BABY_QUOTA_ENGINE' THEN
    v_meta := v_meta
      - 'hard_pause_started_at'
      - 'hard_pause_cycle_key'
      - 'hard_pause_admission_id'
      - 'hard_pause_reason'
      - 'hard_pause_entitlement_source'
      - 'hard_pause_owner'
      - 'hard_pause_source'
      - 'pause_started_at'
      - 'data_gap_start';
    IF COALESCE(v_meta->>'sync_state', '') = 'HARD_PAUSED' THEN
      v_meta := v_meta || jsonb_build_object('sync_state', 'FULL');
    END IF;
    IF COALESCE(v_meta->>'access_profile', '') = 'ARCHIVE_READ_ONLY' THEN
      v_meta := v_meta || jsonb_build_object('access_profile', 'FULL_ACCESS');
    END IF;
    IF COALESCE(v_meta->>'usage_state', '') = 'LIMIT_REACHED' THEN
      v_meta := v_meta || jsonb_build_object('usage_state', 'WITHIN_LIMIT');
    END IF;
  END IF;

  v_prec := public.billing_internal_resolve_access_precedence(v_meta);
  -- Restrições superiores (rank < 6) permanecem; não forçar FULL_ACCESS.
  RETURN v_meta || jsonb_build_object(
    'access_precedence_rank', (v_prec->>'precedence_rank')::integer,
    'access_precedence_reason', v_prec->>'reason'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_materialize_open_cycle_sales_limit_snapshot(
  p_subscription_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb;
  v_cycle text;
  v_plan_key text;
  v_limit integer;
  v_now timestamptz := now();
BEGIN
  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = p_subscription_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_admission: subscription_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_meta := COALESCE(v_meta, '{}'::jsonb);

  IF NOT COALESCE((v_meta->>'suspension_fallback_active')::boolean, false)
     OR COALESCE(v_meta->>'effective_entitlement', '') <> 'BABY_INTERNAL_FREE' THEN
    RETURN jsonb_build_object('materialized', false, 'reason', 'not_baby_fallback');
  END IF;

  v_cycle := COALESCE(
    NULLIF(v_meta->>'usage_limit_cycle_key', ''),
    NULLIF(v_meta->>'fallback_period_start', '')
  );

  IF v_cycle IS NULL OR btrim(v_cycle) = '' THEN
    RAISE EXCEPTION 'billing_admission: canonical_cycle_missing' USING ERRCODE = 'P0001';
  END IF;

  -- Fallback Baby: limite canônico do plano baby. Contrato pago permanece só para histórico/reativação.
  v_plan_key := 'baby';

  IF NULLIF(v_meta->>'sales_limit_snapshot_cycle_key', '') = v_cycle
     AND NULLIF(v_meta->>'sales_limit_snapshot', '')::integer > 0 THEN
    RETURN jsonb_build_object(
      'materialized', false,
      'idempotent', true,
      'cycle_key', v_cycle,
      'plan_key', v_plan_key,
      'sales_limit_snapshot', (v_meta->>'sales_limit_snapshot')::integer
    );
  END IF;

  v_limit := public.billing_internal_read_plan_sales_limit_from_catalog(v_plan_key);

  -- Virada de ciclo: zera contador; só limpa pausa BABY_QUOTA_ENGINE do ciclo anterior.
  IF NULLIF(v_meta->>'sales_limit_snapshot_cycle_key', '') IS DISTINCT FROM v_cycle THEN
    v_meta := v_meta || jsonb_build_object('usage_billed_count', 0);

    IF COALESCE(v_meta->>'hard_pause_owner', '') = 'BABY_QUOTA_ENGINE'
       AND COALESCE(v_meta->>'hard_pause_cycle_key', '') IS DISTINCT FROM v_cycle
       AND NULLIF(v_meta->>'hard_pause_admission_id', '') IS NOT NULL
       AND COALESCE((public.billing_internal_resolve_access_precedence(v_meta)->>'precedence_rank')::integer, 99) >= 4 THEN
      v_meta := public.billing_internal_apply_access_precedence_after_baby_clear(v_meta);
    END IF;
  END IF;

  UPDATE public.billing_subscriptions
  SET metadata = v_meta || jsonb_build_object(
    'usage_limit_cycle_key', v_cycle,
    'sales_limit_snapshot', v_limit,
    'sales_limit_snapshot_cycle_key', v_cycle,
    'sales_limit_snapshot_materialized_at', v_now
  ),
  updated_at = v_now
  WHERE id = p_subscription_id;

  RETURN jsonb_build_object(
    'materialized', true,
    'cycle_key', v_cycle,
    'plan_key', v_plan_key,
    'sales_limit_snapshot', v_limit,
    'cycle_rollover_baby_pause_cleared',
      COALESCE(v_meta->>'hard_pause_reason', '') IS DISTINCT FROM 'BABY_LIMIT_REACHED'
      OR COALESCE(v_meta->>'hard_pause_cycle_key', '') = v_cycle
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_resolve_current_baby_cycle(
  p_user_id uuid,
  p_subscription_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canonical_cycle text;
BEGIN
  SELECT COALESCE(
    NULLIF(bs.metadata->>'usage_limit_cycle_key', ''),
    NULLIF(bs.metadata->>'fallback_period_start', '')
  )
  INTO v_canonical_cycle
  FROM public.billing_subscriptions bs
  WHERE bs.id = p_subscription_id
    AND bs.user_id = p_user_id;

  IF v_canonical_cycle IS NULL OR btrim(v_canonical_cycle) = '' THEN
    RAISE EXCEPTION 'billing_admission: canonical_cycle_missing' USING ERRCODE = 'P0001';
  END IF;

  RETURN public.billing_internal_resolve_baby_admission_context(
    p_user_id, p_subscription_id, v_canonical_cycle, NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_validate_marketplace_account(
  p_user_id uuid,
  p_marketplace text,
  p_marketplace_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 6.9A.9 — identidade completa obrigatória (sem NULL, sem UUID zero).
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_marketplace IS NULL OR btrim(p_marketplace) = '' THEN
    RETURN false;
  END IF;
  IF p_marketplace_account_id IS NULL THEN
    RETURN false;
  END IF;

  IF to_regclass('public.marketplace_accounts') IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.marketplace_accounts ma
    WHERE ma.id = p_marketplace_account_id
      AND ma.user_id = p_user_id
      AND ma.marketplace = p_marketplace
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_sync_subscription_usage_count(
  p_subscription_id uuid,
  p_cycle_key text,
  p_meta jsonb,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  v_count := public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key);
  v_meta := v_meta || jsonb_build_object('usage_billed_count', v_count);
  UPDATE public.billing_subscriptions
  SET metadata = v_meta, updated_at = p_now
  WHERE id = p_subscription_id;
  RETURN v_meta;
END;
$$;

-- Lock order: subscription → admission
CREATE OR REPLACE FUNCTION public.billing_internal_finalize_admission_row(
  p_admission_id uuid,
  p_persisted_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_meta jsonb;
  v_subscription_id uuid;
  v_now timestamptz := now();
  v_pause_applied boolean := false;
  v_current_ctx jsonb;
  v_current_cycle text;
  v_current_limit integer;
  v_recalculated_count integer;
  v_historical boolean := false;
  v_entitlement_changed boolean := false;
  v_row_limit integer;
BEGIN
  SELECT subscription_id INTO v_subscription_id
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'reservation_not_found');
  END IF;

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id
  FOR UPDATE;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'reservation_not_found');
  END IF;

  v_current_ctx := public.billing_internal_read_open_cycle_snapshot(v_row.subscription_id);
  v_current_cycle := v_current_ctx->>'cycle_key';
  v_current_limit := NULLIF(v_current_ctx->>'sales_limit_snapshot', '')::integer;
  v_row_limit := COALESCE(v_row.cycle_limit_snapshot, NULLIF(v_meta->>'sales_limit_snapshot', '')::integer, v_current_limit);

  IF v_row.admission_result = 'PERSISTED' THEN
    v_recalculated_count := public.billing_count_active_billable_slots(v_row.subscription_id, v_row.cycle_key);
    RETURN jsonb_build_object(
      'finalized', true,
      'idempotent', true,
      'reason', 'already_persisted',
      'reservation_id', p_admission_id,
      'usage_count', v_recalculated_count,
      'usage_limit', COALESCE(v_row_limit, v_current_limit),
      'pause_applied', COALESCE(v_row.pause_applied, false)
        OR (COALESCE(v_meta->>'sync_state', '') = 'HARD_PAUSED'
            AND COALESCE(v_meta->>'hard_pause_cycle_key', '') = v_row.cycle_key),
      'activate_hard_pause', COALESCE(v_meta->>'sync_state', '') = 'HARD_PAUSED'
        AND COALESCE(v_meta->>'hard_pause_cycle_key', '') = v_row.cycle_key,
      'access_profile', COALESCE(v_meta->>'access_profile', 'FULL_ACCESS')
    );
  END IF;
  v_historical := v_row.cycle_key IS DISTINCT FROM v_current_cycle;
  v_entitlement_changed := COALESCE(v_current_ctx->>'effective_entitlement', '') <> 'BABY_INTERNAL_FREE'
    OR NOT COALESCE((v_current_ctx->>'suspension_fallback_active')::boolean, false);

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'PERSISTED',
      persisted_at = COALESCE(p_persisted_at, v_now),
      finalized_at = v_now,
      reservation_expires_at = NULL,
      reservation_heartbeat_at = NULL,
      next_recovery_at = NULL,
      recovery_reason = NULL,
      last_error_code = CASE
        WHEN v_historical THEN 'finalized_after_cycle_rollover'
        WHEN v_entitlement_changed THEN 'finalized_after_entitlement_change'
        ELSE NULL
      END,
      updated_at = v_now
  WHERE id = p_admission_id;

  v_meta := COALESCE(v_meta, '{}'::jsonb) || jsonb_build_object(
    'last_successful_data_update_at', COALESCE(p_persisted_at, v_now)
  );

  IF v_historical OR v_entitlement_changed THEN
    v_recalculated_count := public.billing_count_active_billable_slots(v_row.subscription_id, v_current_cycle);
    UPDATE public.billing_subscriptions
    SET metadata = v_meta, updated_at = v_now
    WHERE id = v_row.subscription_id;

    RETURN jsonb_build_object(
      'finalized', true,
      'reservation_id', p_admission_id,
      'historical_cycle', true,
      'entitlement_changed', v_entitlement_changed,
      'reservation_cycle_key', v_row.cycle_key,
      'current_cycle_key', v_current_cycle,
      'usage_count', v_recalculated_count,
      'usage_limit', v_current_limit,
      'pause_applied', false,
      'activate_hard_pause', false
    );
  END IF;

  v_recalculated_count := public.billing_count_active_billable_slots(v_row.subscription_id, v_current_cycle);
  v_meta := v_meta || jsonb_build_object('usage_billed_count', v_recalculated_count);

  IF v_recalculated_count >= COALESCE(v_row_limit, v_current_limit, 0) THEN
    IF COALESCE(v_meta->>'hard_pause_cycle_key', '') <> v_current_cycle
       OR COALESCE(v_meta->>'hard_pause_admission_id', '') = '' THEN
      v_pause_applied := true;
      UPDATE public.billing_billable_sale_admissions
      SET pause_applied = true,
          pause_cycle_key = v_current_cycle,
          pause_reason = 'BABY_LIMIT_REACHED',
          previous_sync_state = COALESCE(v_meta->>'sync_state', 'FULL'),
          previous_usage_state = COALESCE(v_meta->>'usage_state', 'WITHIN_LIMIT'),
          previous_access_profile = COALESCE(v_meta->>'access_profile', 'FULL_ACCESS'),
          updated_at = v_now
      WHERE id = p_admission_id;
      v_meta := v_meta || jsonb_build_object(
        'sync_state', 'HARD_PAUSED',
        'usage_state', 'HARD_LIMIT_REACHED',
        'access_profile', 'ARCHIVE_READ_ONLY',
        'hard_pause_started_at', v_now,
        'hard_pause_cycle_key', v_current_cycle,
        'hard_pause_admission_id', p_admission_id::text,
        'hard_pause_reason', 'BABY_LIMIT_REACHED',
        'hard_pause_owner', 'BABY_QUOTA_ENGINE',
        'hard_pause_source', 'RUNTIME',
        'hard_pause_entitlement_source', COALESCE(v_row.entitlement_source, 'suspension_fallback'),
        'pause_started_at', v_now,
        'data_gap_start', to_char(v_now AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD')
      );
    END IF;
  END IF;

  UPDATE public.billing_subscriptions
  SET metadata = v_meta, updated_at = v_now
  WHERE id = v_row.subscription_id;

  RETURN jsonb_build_object(
    'finalized', true,
    'reservation_id', p_admission_id,
    'usage_count', v_recalculated_count,
    'usage_limit', v_current_limit,
    'pause_applied', v_pause_applied,
    'activate_hard_pause', v_recalculated_count >= COALESCE(v_row_limit, v_current_limit, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_release_admission_row(
  p_admission_id uuid,
  p_reason text DEFAULT 'persist_failed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_meta jsonb;
  v_subscription_id uuid;
  v_count integer;
  v_now timestamptz := now();
  v_current_ctx jsonb;
  v_current_cycle text;
  v_historical boolean := false;
  v_entitlement_changed boolean := false;
BEGIN
  SELECT subscription_id INTO v_subscription_id
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'reservation_not_found');
  END IF;

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id
  FOR UPDATE;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND admission_result = 'RESERVED'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'reservation_not_found_or_not_reserved');
  END IF;

  v_current_ctx := public.billing_internal_read_open_cycle_snapshot(v_row.subscription_id);
  v_current_cycle := v_current_ctx->>'cycle_key';
  v_historical := v_row.cycle_key IS DISTINCT FROM v_current_cycle;
  v_entitlement_changed := COALESCE(v_current_ctx->>'effective_entitlement', '') <> 'BABY_INTERNAL_FREE'
    OR NOT COALESCE((v_current_ctx->>'suspension_fallback_active')::boolean, false);

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'ROLLED_BACK',
      rolled_back_at = v_now,
      reservation_expires_at = NULL,
      reservation_heartbeat_at = NULL,
      next_recovery_at = NULL,
      last_error_code = CASE
        WHEN v_historical THEN 'released_after_cycle_rollover'
        WHEN v_entitlement_changed THEN 'released_after_entitlement_change'
        ELSE COALESCE(p_reason, 'persist_failed')
      END,
      updated_at = v_now
  WHERE id = p_admission_id;

  IF v_historical OR v_entitlement_changed THEN
    RETURN jsonb_build_object(
      'released', true,
      'historical', true,
      'entitlement_changed', v_entitlement_changed,
      'reservation_cycle_key', v_row.cycle_key,
      'current_cycle_key', v_current_cycle,
      'reservation_id', p_admission_id
    );
  END IF;

  v_meta := public.billing_internal_sync_subscription_usage_count(
    v_row.subscription_id, v_row.cycle_key, v_meta, v_now
  );
  v_count := (v_meta->>'usage_billed_count')::integer;

  IF v_row.pause_applied
     AND COALESCE(v_meta->>'hard_pause_owner', '') = 'BABY_QUOTA_ENGINE'
     AND COALESCE(v_meta->>'hard_pause_admission_id', '') = p_admission_id::text
     AND COALESCE(v_meta->>'hard_pause_cycle_key', '') = v_row.cycle_key THEN
    v_meta := public.billing_internal_apply_access_precedence_after_baby_clear(v_meta);
    UPDATE public.billing_subscriptions
    SET metadata = v_meta, updated_at = v_now
    WHERE id = v_row.subscription_id;
  END IF;

  RETURN jsonb_build_object(
    'released', true,
    'usage_count', v_count,
    'reservation_id', p_admission_id,
    'access_profile', COALESCE(v_meta->>'access_profile', 'FULL_ACCESS')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_expire_admission_row(
  p_admission_id uuid,
  p_reason text DEFAULT 'reservation_expired_reconcile'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_meta jsonb;
  v_subscription_id uuid;
  v_count integer;
  v_now timestamptz := now();
  v_current_ctx jsonb;
  v_current_cycle text;
  v_historical boolean := false;
  v_entitlement_changed boolean := false;
BEGIN
  SELECT subscription_id INTO v_subscription_id
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('expired', false, 'reason', 'reservation_not_found');
  END IF;

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id
  FOR UPDATE;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND admission_result IN ('RESERVED', 'RECOVERY_REQUIRED')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('expired', false, 'reason', 'reservation_not_found');
  END IF;

  v_current_ctx := public.billing_internal_read_open_cycle_snapshot(v_row.subscription_id);
  v_current_cycle := v_current_ctx->>'cycle_key';
  v_historical := v_row.cycle_key IS DISTINCT FROM v_current_cycle;
  v_entitlement_changed := COALESCE(v_current_ctx->>'effective_entitlement', '') <> 'BABY_INTERNAL_FREE'
    OR NOT COALESCE((v_current_ctx->>'suspension_fallback_active')::boolean, false);

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'EXPIRED',
      expired_at = v_now,
      reservation_expires_at = NULL,
      reservation_heartbeat_at = NULL,
      next_recovery_at = NULL,
      last_error_code = CASE
        WHEN v_historical THEN 'expired_after_cycle_rollover'
        WHEN v_entitlement_changed THEN 'expired_after_entitlement_change'
        ELSE COALESCE(p_reason, 'reservation_expired_reconcile')
      END,
      updated_at = v_now
  WHERE id = p_admission_id;

  IF v_historical OR v_entitlement_changed THEN
    RETURN jsonb_build_object(
      'expired', true,
      'historical', true,
      'entitlement_changed', v_entitlement_changed,
      'reservation_cycle_key', v_row.cycle_key,
      'current_cycle_key', v_current_cycle,
      'reservation_id', p_admission_id
    );
  END IF;

  v_meta := public.billing_internal_sync_subscription_usage_count(
    v_row.subscription_id, v_row.cycle_key, v_meta, v_now
  );
  v_count := (v_meta->>'usage_billed_count')::integer;

  IF v_row.pause_applied
     AND COALESCE(v_meta->>'hard_pause_owner', '') = 'BABY_QUOTA_ENGINE'
     AND COALESCE(v_meta->>'hard_pause_admission_id', '') = p_admission_id::text
     AND COALESCE(v_meta->>'hard_pause_cycle_key', '') = v_row.cycle_key THEN
    v_meta := public.billing_internal_apply_access_precedence_after_baby_clear(v_meta);
    UPDATE public.billing_subscriptions
    SET metadata = v_meta, updated_at = v_now
    WHERE id = v_row.subscription_id;
  END IF;

  RETURN jsonb_build_object(
    'expired', true,
    'usage_count', v_count,
    'reservation_id', p_admission_id,
    'access_profile', COALESCE(v_meta->>'access_profile', 'FULL_ACCESS')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_mark_recovery_required(
  p_admission_id uuid,
  p_reason text,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_meta jsonb;
  v_subscription_id uuid;
  v_now timestamptz := now();
  v_max_attempts constant integer := 10;
  v_next_attempt integer;
  v_backoff interval;
  v_audit jsonb;
BEGIN
  SELECT subscription_id INTO v_subscription_id
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'reservation_not_found');
  END IF;

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id
  FOR UPDATE;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND admission_result IN ('RESERVED', 'RECOVERY_REQUIRED')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'reservation_not_found');
  END IF;

  v_next_attempt := COALESCE(v_row.recovery_attempt_count, 0) + 1;
  v_backoff := interval '5 minutes' * power(2, LEAST(GREATEST(v_next_attempt - 1, 0), 5));

  IF v_next_attempt >= v_max_attempts THEN
    UPDATE public.billing_billable_sale_admissions
    SET admission_result = 'RECOVERY_REQUIRED',
        reservation_expires_at = NULL,
        recovery_attempt_count = v_next_attempt,
        last_recovery_at = v_now,
        next_recovery_at = NULL,
        recovery_reason = COALESCE(p_reason, 'recovery_exhausted'),
        last_error_code = COALESCE(p_error_code, 'recovery_exhausted'),
        updated_at = v_now
    WHERE id = p_admission_id;

    v_audit := COALESCE(v_meta->'billing_admission_recovery_alerts', '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'at', v_now,
        'admission_id', p_admission_id,
        'reason', COALESCE(p_reason, 'recovery_exhausted'),
        'attempts', v_next_attempt
      )
    );
    UPDATE public.billing_subscriptions
    SET metadata = COALESCE(v_meta, '{}'::jsonb) || jsonb_build_object(
      'billing_admission_recovery_alerts', v_audit
    ),
    updated_at = v_now
    WHERE id = v_row.subscription_id;

    RETURN jsonb_build_object(
      'marked', true,
      'recovery_required', true,
      'recovery_exhausted', true,
      'recovery_attempt_count', v_next_attempt
    );
  END IF;

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'RECOVERY_REQUIRED',
      reservation_expires_at = NULL,
      recovery_attempt_count = v_next_attempt,
      last_recovery_at = v_now,
      next_recovery_at = v_now + v_backoff,
      recovery_reason = COALESCE(p_reason, 'recovery_required'),
      last_error_code = COALESCE(p_error_code, 'recovery_required'),
      updated_at = v_now
  WHERE id = p_admission_id;

  RETURN jsonb_build_object(
    'marked', true,
    'recovery_required', true,
    'recovery_attempt_count', v_next_attempt,
    'next_recovery_at', v_now + v_backoff
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_internal_reconcile_admission_row(
  p_admission_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_subscription_id uuid;
  v_sale_exists boolean := false;
  v_sale_ambiguous boolean := false;
  v_has_sales_orders boolean := to_regclass('public.sales_orders') IS NOT NULL;
  v_result jsonb;
BEGIN
  SELECT subscription_id INTO v_subscription_id
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'reservation_not_found');
  END IF;

  PERFORM 1 FROM public.billing_subscriptions WHERE id = v_subscription_id FOR UPDATE;

  SELECT * INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_admission_id
    AND admission_result IN ('RESERVED', 'RECOVERY_REQUIRED')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'not_eligible');
  END IF;

  IF v_row.admission_result = 'RESERVED'
     AND (v_row.reservation_expires_at IS NULL OR v_row.reservation_expires_at > now()) THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'lease_still_active');
  END IF;

  IF v_row.admission_result = 'RESERVED'
     AND v_row.reservation_heartbeat_at IS NOT NULL
     AND v_row.reservation_heartbeat_at > now() - interval '90 seconds' THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'heartbeat_active');
  END IF;

  IF v_has_sales_orders THEN
    SELECT
      COUNT(*) > 0,
      COUNT(*) > 1
    INTO v_sale_exists, v_sale_ambiguous
    FROM public.sales_orders so
    WHERE so.user_id = v_row.user_id
      AND so.external_order_id = v_row.external_order_id
      AND (v_row.marketplace IS NULL OR btrim(v_row.marketplace) = '' OR so.marketplace = v_row.marketplace)
      AND (
        v_row.marketplace_account_id IS NULL
        OR so.marketplace_account_id = v_row.marketplace_account_id
      );
  END IF;

  IF NOT v_has_sales_orders OR v_sale_ambiguous THEN
    RETURN public.billing_internal_mark_recovery_required(
      p_admission_id,
      CASE
        WHEN NOT v_has_sales_orders THEN 'reconcile_sales_orders_unavailable'
        ELSE 'reconcile_sale_ambiguous'
      END,
      CASE
        WHEN NOT v_has_sales_orders THEN 'reconcile_sales_orders_unavailable'
        ELSE 'reconcile_sale_ambiguous'
      END
    ) || jsonb_build_object('reconciled', true);
  END IF;

  IF v_sale_exists THEN
    v_result := public.billing_internal_finalize_admission_row(p_admission_id, now());
    RETURN v_result || jsonb_build_object(
      'reconciled', COALESCE((v_result->>'finalized')::boolean, false)
    );
  END IF;

  v_result := public.billing_internal_expire_admission_row(p_admission_id, 'reservation_expired_reconcile');
  RETURN v_result || jsonb_build_object(
    'reconciled', COALESCE((v_result->>'expired')::boolean, false)
  );
END;
$$;

DROP FUNCTION IF EXISTS public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean);

CREATE OR REPLACE FUNCTION public.billing_reserve_billable_sale_v2(
  p_user_id uuid,
  p_subscription_id uuid,
  p_cycle_key text,
  p_external_order_id text,
  p_reservation_owner_token uuid,
  p_marketplace text DEFAULT NULL,
  p_marketplace_account_id uuid DEFAULT NULL,
  p_usage_limit integer DEFAULT NULL,
  p_simulate_tx_failure boolean DEFAULT false,
  p_official_order_at timestamptz DEFAULT NULL,
  p_snapshot_origin text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta jsonb;
  v_prec jsonb;
  v_window jsonb;
  v_quota_start timestamptz;
  v_origin text;
  v_ctx jsonb;
  v_limit integer;
  v_current integer;
  v_actual integer;
  v_audit_position integer;
  v_reservation_id uuid;
  v_existing_owner uuid;
  v_attempt_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_expires timestamptz := now() + interval '15 minutes';
  v_hard_pause_cycle text;
  v_sync_state text;
  v_idempotency text;
BEGIN
  IF p_user_id IS NULL OR p_subscription_id IS NULL OR p_cycle_key IS NULL
     OR p_external_order_id IS NULL OR btrim(p_external_order_id) = ''
     OR p_reservation_owner_token IS NULL THEN
    RETURN jsonb_build_object('admit', false, 'reason', 'invalid_input', 'process_sale', false);
  END IF;

  IF p_marketplace IS NULL OR btrim(p_marketplace) = '' OR p_marketplace_account_id IS NULL THEN
    RETURN jsonb_build_object(
      'admit', false,
      'reason', 'incomplete_marketplace_identity',
      'process_sale', false
    );
  END IF;

  IF NOT public.billing_internal_validate_marketplace_account(
    p_user_id, p_marketplace, p_marketplace_account_id
  ) THEN
    RETURN jsonb_build_object(
      'admit', false,
      'reason', 'marketplace_account_invalid',
      'process_sale', false
    );
  END IF;

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = p_subscription_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('admit', false, 'reason', 'subscription_not_found', 'process_sale', false);
  END IF;

  v_origin := COALESCE(NULLIF(btrim(p_snapshot_origin), ''), 'unknown');
  v_prec := public.billing_internal_resolve_access_precedence(v_meta);
  IF NOT COALESCE((v_prec->>'allow_process_sale')::boolean, false) THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', v_prec->>'reason',
      'domain_code', v_prec->>'domain_code',
      'precedence_rank', (v_prec->>'precedence_rank')::integer,
      'webhook_ok', true
    );
  END IF;

  IF v_origin = 'onboarding_import' THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', 'onboarding_import_not_reservable',
      'atomic', false
    );
  END IF;

  v_window := public.billing_internal_resolve_baby_cycle_window(v_meta);
  BEGIN
    v_quota_start := NULLIF(v_meta->>'quota_counting_started_at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_quota_start := NULL;
  END;

  -- Trial temporal: RPC não cria admission de consumo (gate Node também bypassa).
  IF COALESCE(v_meta->>'trial_state', '') IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY') THEN
    IF NOT COALESCE((v_prec->>'allow_quota_bypass_trial')::boolean, false) THEN
      RETURN jsonb_build_object(
        'admit', false,
        'process_sale', false,
        'reason', v_prec->>'reason',
        'precedence_rank', (v_prec->>'precedence_rank')::integer,
        'webhook_ok', true
      );
    END IF;
    RETURN jsonb_build_object(
      'admit', true,
      'process_sale', true,
      'reason', 'trial_unlimited',
      'atomic', false,
      'quota_bypassed', true,
      'usage_count', 0,
      'usage_limit', null
    );
  END IF;

  IF NULLIF(v_meta->>'quota_counting_started_at', '') IS NULL THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', 'quota_counting_not_started'
    );
  END IF;

  IF p_official_order_at IS NULL THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', 'manual_review_required',
      'classification_reason', 'official_order_at_missing',
      'webhook_ok', true,
      'manual_review_required', true,
      'atomic', false
    );
  END IF;

  BEGIN
    v_quota_start := (v_meta->>'quota_counting_started_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('admit', false, 'process_sale', false, 'reason', 'quota_counting_started_at_invalid');
  END;

  IF p_official_order_at < v_quota_start THEN
    RETURN jsonb_build_object(
      'admit', true,
      'process_sale', true,
      'reason', 'before_quota_counting_started',
      'atomic', false,
      'quota_bypassed', true
    );
  END IF;

  v_window := public.billing_internal_resolve_baby_cycle_window(v_meta);
  IF NOT COALESCE((v_window->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', 'manual_review_required',
      'classification_reason', 'cycle_window_unresolved',
      'manual_review_required', true
    );
  END IF;

  IF p_official_order_at < GREATEST(v_quota_start, (v_window->>'cycle_started_at')::timestamptz)
     OR p_official_order_at >= (v_window->>'cycle_ends_at_exclusive')::timestamptz THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', 'manual_review_required',
      'classification_reason', 'outside_current_cycle_window',
      'manual_review_required', true
    );
  END IF;

  PERFORM public.billing_internal_materialize_open_cycle_sales_limit_snapshot(p_subscription_id);

  SELECT metadata INTO v_meta
  FROM public.billing_subscriptions
  WHERE id = p_subscription_id AND user_id = p_user_id;

  v_ctx := public.billing_internal_resolve_baby_admission_context(
    p_user_id, p_subscription_id, p_cycle_key, p_usage_limit
  );
  v_limit := (v_ctx->>'usage_limit')::integer;
  v_idempotency := public.billing_internal_build_admission_idempotency_key(
    p_subscription_id, p_cycle_key, p_marketplace, p_marketplace_account_id, p_external_order_id
  );

  v_sync_state := COALESCE(v_meta->>'sync_state', 'FULL');
  v_hard_pause_cycle := COALESCE(v_meta->>'hard_pause_cycle_key', '');

  IF v_sync_state = 'HARD_PAUSED' AND v_hard_pause_cycle = p_cycle_key THEN
    RETURN jsonb_build_object(
      'admit', false,
      'reason', 'hard_paused',
      'domain_code', 'BABY_HARD_LIMIT_REACHED',
      'process_sale', false,
      'usage_count', public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key),
      'usage_limit', v_limit
    );
  END IF;

  SELECT id INTO v_reservation_id
  FROM public.billing_billable_sale_admissions
  WHERE subscription_id = p_subscription_id
    AND cycle_key = p_cycle_key
    AND marketplace = p_marketplace
    AND marketplace_account_id = p_marketplace_account_id
    AND external_order_id = p_external_order_id
    AND admission_result = 'PERSISTED'
  LIMIT 1;

  IF v_reservation_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'admit', false,
      'reason', 'duplicate',
      'duplicate', true,
      'domain_code', 'ALREADY_RECORDED',
      'process_sale', false,
      'reservation_id', v_reservation_id,
      'admission_id', v_reservation_id
    );
  END IF;

  SELECT id INTO v_reservation_id
  FROM public.billing_billable_sale_admissions
  WHERE subscription_id = p_subscription_id
    AND cycle_key = p_cycle_key
    AND marketplace = p_marketplace
    AND marketplace_account_id = p_marketplace_account_id
    AND external_order_id = p_external_order_id
    AND admission_result = 'RECOVERY_REQUIRED'
  LIMIT 1;

  IF v_reservation_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'admit', false,
      'process_sale', false,
      'reason', 'recovery_in_progress',
      'admission_id', v_reservation_id,
      'reservation_id', v_reservation_id,
      'usage_count', public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key),
      'usage_limit', v_limit,
      'atomic', true
    );
  END IF;

  SELECT id, reservation_owner_token
  INTO v_reservation_id, v_existing_owner
  FROM public.billing_billable_sale_admissions
  WHERE subscription_id = p_subscription_id
    AND cycle_key = p_cycle_key
    AND marketplace = p_marketplace
    AND marketplace_account_id = p_marketplace_account_id
    AND external_order_id = p_external_order_id
    AND admission_result = 'RESERVED'
  FOR UPDATE;

  IF v_reservation_id IS NOT NULL THEN
    IF v_existing_owner = p_reservation_owner_token THEN
      UPDATE public.billing_billable_sale_admissions
      SET reservation_heartbeat_at = v_now,
          reservation_expires_at = v_expires,
          updated_at = v_now
      WHERE id = v_reservation_id;
      RETURN jsonb_build_object(
        'admit', true,
        'reason', 'reservation_reused',
        'process_sale', true,
        'reservation_id', v_reservation_id,
        'usage_count', public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key),
        'usage_limit', v_limit,
        'atomic', true
      );
    END IF;

    RETURN jsonb_build_object(
      'admit', false,
      'reason', 'reservation_in_progress',
      'process_sale', false,
      'reservation_id', v_reservation_id,
      'usage_count', public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key),
      'usage_limit', v_limit,
      'atomic', true
    );
  END IF;

  v_current := public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key);
  IF v_current >= v_limit THEN
    RETURN jsonb_build_object(
      'admit', false,
      'reason', 'baby_hard_limit_reached',
      'domain_code', 'BABY_HARD_LIMIT_REACHED',
      'process_sale', false,
      'usage_count', v_current,
      'usage_limit', v_limit
    );
  END IF;

  IF p_simulate_tx_failure THEN
    RAISE EXCEPTION 'billing_admission_simulated_failure' USING ERRCODE = 'P0001';
  END IF;

  v_audit_position := v_current + 1;

  UPDATE public.billing_billable_sale_admissions
  SET admission_result = 'RESERVED',
      usage_count_after = v_audit_position,
      usage_limit = v_limit,
      cycle_limit_snapshot = v_limit,
      entitlement_type = v_ctx->>'entitlement_type',
      entitlement_source = v_ctx->>'entitlement_source',
      idempotency_key = v_idempotency,
      marketplace = p_marketplace,
      marketplace_account_id = p_marketplace_account_id,
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
  WHERE subscription_id = p_subscription_id
    AND cycle_key = p_cycle_key
    AND marketplace = p_marketplace
    AND marketplace_account_id = p_marketplace_account_id
    AND external_order_id = p_external_order_id
    AND admission_result IN ('ROLLED_BACK', 'EXPIRED')
  RETURNING id INTO v_reservation_id;

  IF v_reservation_id IS NULL THEN
    INSERT INTO public.billing_billable_sale_admissions (
      user_id, subscription_id, cycle_key, external_order_id,
      marketplace, marketplace_account_id, admission_result,
      usage_count_after, usage_limit, cycle_limit_snapshot, entitlement_type, entitlement_source,
      idempotency_key, reservation_owner_token, reservation_attempt_id,
      reserved_at, reservation_expires_at, reservation_heartbeat_at, updated_at, created_at
    ) VALUES (
      p_user_id, p_subscription_id, p_cycle_key, p_external_order_id,
      p_marketplace, p_marketplace_account_id, 'RESERVED',
      v_audit_position, v_limit, v_limit, v_ctx->>'entitlement_type', v_ctx->>'entitlement_source',
      v_idempotency, p_reservation_owner_token, v_attempt_id,
      v_now, v_expires, v_now, v_now, v_now
    )
    RETURNING id INTO v_reservation_id;
  END IF;

  v_actual := public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key);
  v_meta := public.billing_internal_sync_subscription_usage_count(
    p_subscription_id, p_cycle_key, v_meta, v_now
  );

  RETURN jsonb_build_object(
    'admit', true,
    'reason', CASE WHEN v_actual >= v_limit THEN 'baby_last_slot' ELSE 'baby_within_limit' END,
    'process_sale', true,
    'activate_hard_pause', false,
    'reservation_id', v_reservation_id,
    'admission_id', v_reservation_id,
    'usage_count', v_actual,
    'usage_limit', v_limit,
    'reservation_expires_at', v_expires,
    'atomic', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_renew_billable_sale_reservation_lease_v2(
  p_user_id uuid,
  p_reservation_id uuid,
  p_reservation_owner_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_subscription_id uuid;
  v_admission_result text;
  v_updated_id uuid;
  v_now timestamptz := now();
  v_expires timestamptz := now() + interval '15 minutes';
BEGIN
  IF p_user_id IS NULL OR p_reservation_id IS NULL OR p_reservation_owner_token IS NULL THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'invalid_input');
  END IF;

  SELECT subscription_id
  INTO v_subscription_id
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
    AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'reservation_not_found');
  END IF;

  PERFORM 1
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id AND user_id = p_user_id
  FOR UPDATE;

  SELECT admission_result, reservation_owner_token
  INTO v_admission_result, v_owner
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'reservation_not_found');
  END IF;

  IF v_admission_result IS DISTINCT FROM 'RESERVED' THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'reservation_no_longer_active');
  END IF;

  IF v_owner IS DISTINCT FROM p_reservation_owner_token THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'reservation_owner_mismatch');
  END IF;

  UPDATE public.billing_billable_sale_admissions
  SET reservation_heartbeat_at = v_now,
      reservation_expires_at = v_expires,
      updated_at = v_now
  WHERE id = p_reservation_id
    AND user_id = p_user_id
    AND admission_result = 'RESERVED'
    AND reservation_owner_token = p_reservation_owner_token
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'reservation_no_longer_active');
  END IF;

  RETURN jsonb_build_object(
    'renewed', true,
    'reservation_id', p_reservation_id,
    'reservation_expires_at', v_expires
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_finalize_billable_sale_v2(
  p_user_id uuid,
  p_reservation_id uuid,
  p_reservation_owner_token uuid,
  p_persisted_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_subscription_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_reservation_id IS NULL OR p_reservation_owner_token IS NULL THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'invalid_input');
  END IF;

  SELECT subscription_id, reservation_owner_token
  INTO v_subscription_id, v_owner
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
    AND user_id = p_user_id
    AND admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED');

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'reservation_not_found');
  END IF;

  PERFORM 1
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id AND user_id = p_user_id
  FOR UPDATE;

  SELECT reservation_owner_token INTO v_owner
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF v_owner IS DISTINCT FROM p_reservation_owner_token THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'reservation_owner_mismatch');
  END IF;

  RETURN public.billing_internal_finalize_admission_row(p_reservation_id, p_persisted_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_release_billable_sale_v2(
  p_user_id uuid,
  p_reservation_id uuid,
  p_reservation_owner_token uuid,
  p_reason text DEFAULT 'persist_failed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.billing_billable_sale_admissions%ROWTYPE;
  v_owner uuid;
  v_subscription_id uuid;
  v_sale_exists boolean := false;
  v_sale_ambiguous boolean := false;
  v_has_sales_orders boolean := to_regclass('public.sales_orders') IS NOT NULL;
  v_result jsonb;
BEGIN
  IF p_user_id IS NULL OR p_reservation_id IS NULL OR p_reservation_owner_token IS NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'invalid_input');
  END IF;

  SELECT *
  INTO v_row
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
    AND user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'reservation_not_found');
  END IF;

  IF v_row.admission_result = 'RECOVERY_REQUIRED' THEN
    RETURN jsonb_build_object(
      'released', false,
      'reason', 'recovery_required_reconciler_only',
      'admission_id', p_reservation_id
    );
  END IF;

  IF v_row.admission_result IS DISTINCT FROM 'RESERVED' THEN
    RETURN jsonb_build_object('released', false, 'reason', 'reservation_not_reserved');
  END IF;

  v_subscription_id := v_row.subscription_id;

  PERFORM 1
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id AND user_id = p_user_id
  FOR UPDATE;

  SELECT reservation_owner_token INTO v_owner
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
    AND user_id = p_user_id
    AND admission_result = 'RESERVED'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'reservation_no_longer_active');
  END IF;

  IF v_owner IS DISTINCT FROM p_reservation_owner_token THEN
    RETURN jsonb_build_object('released', false, 'reason', 'reservation_owner_mismatch');
  END IF;

  IF v_row.marketplace IS NULL OR btrim(v_row.marketplace) = ''
     OR v_row.marketplace_account_id IS NULL
     OR v_row.external_order_id IS NULL OR btrim(v_row.external_order_id) = '' THEN
    RETURN public.billing_internal_mark_recovery_required(
      p_reservation_id,
      'release_incomplete_identity',
      'release_incomplete_identity'
    ) || jsonb_build_object('released', false);
  END IF;

  IF v_has_sales_orders THEN
    SELECT COUNT(*) > 0, COUNT(*) > 1
    INTO v_sale_exists, v_sale_ambiguous
    FROM public.sales_orders so
    WHERE so.user_id = p_user_id
      AND so.external_order_id = v_row.external_order_id
      AND so.marketplace = v_row.marketplace
      AND so.marketplace_account_id = v_row.marketplace_account_id;
  END IF;

  IF NOT v_has_sales_orders OR v_sale_ambiguous THEN
    RETURN public.billing_internal_mark_recovery_required(
      p_reservation_id,
      CASE
        WHEN NOT v_has_sales_orders THEN 'release_sales_orders_unavailable'
        ELSE 'release_sale_ambiguous'
      END,
      CASE
        WHEN NOT v_has_sales_orders THEN 'release_sales_orders_unavailable'
        ELSE 'release_sale_ambiguous'
      END
    ) || jsonb_build_object('released', false);
  END IF;

  IF v_sale_exists THEN
    v_result := public.billing_internal_finalize_admission_row(p_reservation_id, now());
    RETURN v_result || jsonb_build_object(
      'released', false,
      'finalized_instead', COALESCE((v_result->>'finalized')::boolean, false),
      'reason', 'sale_already_persisted'
    );
  END IF;

  RETURN public.billing_internal_release_admission_row(p_reservation_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_report_billable_sale_finalize_failure_v2(
  p_user_id uuid,
  p_reservation_id uuid,
  p_reservation_owner_token uuid,
  p_reason text DEFAULT 'finalize_failed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_subscription_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_reservation_id IS NULL OR p_reservation_owner_token IS NULL THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'invalid_input');
  END IF;

  SELECT subscription_id, reservation_owner_token
  INTO v_subscription_id, v_owner
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
    AND user_id = p_user_id
    AND admission_result IN ('RESERVED', 'RECOVERY_REQUIRED');

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'reservation_not_found');
  END IF;

  PERFORM 1
  FROM public.billing_subscriptions
  WHERE id = v_subscription_id AND user_id = p_user_id
  FOR UPDATE;

  SELECT reservation_owner_token INTO v_owner
  FROM public.billing_billable_sale_admissions
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF v_owner IS DISTINCT FROM p_reservation_owner_token THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'reservation_owner_mismatch');
  END IF;

  RETURN public.billing_internal_mark_recovery_required(
    p_reservation_id,
    COALESCE(p_reason, 'finalize_failed'),
    'finalize_failed'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_reconcile_expired_billable_sale_reservations_v1(
  p_batch_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate record;
  v_result jsonb;
  v_reconciled integer := 0;
  v_processed integer := 0;
  v_batch integer := GREATEST(COALESCE(p_batch_limit, 100), 1);
  v_max_attempts constant integer := 10;
BEGIN
  WHILE v_processed < v_batch LOOP
    SELECT a.id, a.subscription_id
    INTO v_candidate
    FROM public.billing_billable_sale_admissions a
    WHERE (
      a.admission_result = 'RESERVED'
      AND a.reservation_expires_at IS NOT NULL
      AND a.reservation_expires_at <= now()
      AND (
        a.reservation_heartbeat_at IS NULL
        OR a.reservation_heartbeat_at <= now() - interval '90 seconds'
      )
    ) OR (
      a.admission_result = 'RECOVERY_REQUIRED'
      AND COALESCE(a.recovery_attempt_count, 0) < v_max_attempts
      AND (a.next_recovery_at IS NULL OR a.next_recovery_at <= now())
    )
    ORDER BY
      CASE WHEN a.admission_result = 'RESERVED' THEN 0 ELSE 1 END,
      COALESCE(a.reservation_expires_at, a.next_recovery_at) ASC NULLS LAST,
      a.updated_at ASC
    LIMIT 1;

    EXIT WHEN NOT FOUND;

    PERFORM 1
    FROM public.billing_subscriptions bs
    WHERE bs.id = v_candidate.subscription_id
    FOR UPDATE;

    SELECT a.id INTO v_candidate.id
    FROM public.billing_billable_sale_admissions a
    WHERE a.id = v_candidate.id
      AND (
        (a.admission_result = 'RESERVED'
         AND a.reservation_expires_at IS NOT NULL
         AND a.reservation_expires_at <= now()
         AND (
           a.reservation_heartbeat_at IS NULL
           OR a.reservation_heartbeat_at <= now() - interval '90 seconds'
         ))
        OR (a.admission_result = 'RECOVERY_REQUIRED'
            AND COALESCE(a.recovery_attempt_count, 0) < v_max_attempts
            AND (a.next_recovery_at IS NULL OR a.next_recovery_at <= now()))
      )
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      v_processed := v_processed + 1;
      CONTINUE;
    END IF;

    v_result := public.billing_internal_reconcile_admission_row(v_candidate.id);
    IF COALESCE((v_result->>'reconciled')::boolean, false)
       OR COALESCE((v_result->>'marked')::boolean, false) THEN
      v_reconciled := v_reconciled + 1;
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object('reconciled', v_reconciled, 'processed', v_processed);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_admit_billable_sale_v1(
  p_user_id uuid,
  p_subscription_id uuid,
  p_cycle_key text,
  p_external_order_id text,
  p_marketplace text DEFAULT NULL,
  p_marketplace_account_id uuid DEFAULT NULL,
  p_usage_limit integer DEFAULT NULL,
  p_simulate_tx_failure boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'admit', false,
    'reason', 'v1_wrapper_disabled_use_v2',
    'process_sale', false,
    'migration', '6.9A.9'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_rollback_billable_sale_admission_v1(
  p_user_id uuid,
  p_admission_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'released', false,
    'reason', 'v1_wrapper_disabled_use_v2',
    'migration', '6.9A.9'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_count_admitted_billable_sales(
  p_subscription_id uuid,
  p_cycle_key text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.billing_count_active_billable_slots(p_subscription_id, p_cycle_key);
$$;

DO $$
BEGIN
  BEGIN REVOKE ALL ON TABLE public.billing_billable_sale_admissions FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_count_active_billable_slots(uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_resolve_baby_admission_context(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_resolve_current_baby_cycle(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_validate_marketplace_account(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_sync_subscription_usage_count(uuid, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_finalize_admission_row(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_release_admission_row(uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_expire_admission_row(uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_mark_recovery_required(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_reconcile_admission_row(uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON TABLE public.billing_internal_deployment_identity FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_read_open_cycle_snapshot(uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_build_admission_idempotency_key(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_read_plan_sales_limit_from_catalog(text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_internal_materialize_open_cycle_sales_limit_snapshot(uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_report_billable_sale_finalize_failure_v2(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_renew_billable_sale_reservation_lease_v2(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_finalize_billable_sale_v2(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_release_billable_sale_v2(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_reconcile_expired_billable_sale_reservations_v1(integer) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_admit_billable_sale_v1(uuid, uuid, text, text, text, uuid, integer, boolean) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_rollback_billable_sale_admission_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_count_admitted_billable_sales(uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
END $$;

COMMIT;
