-- =============================================================================
-- S1.HF.6.9A.11A — Trial lifecycle multi-instance + deploy gates
-- NÃO EXECUTAR nesta missão (somente preparado).
-- =============================================================================

-- 1) Seeds dos type_key (FK de s7_notification_events exige catálogo)
INSERT INTO public.s7_notification_event_types (
  category_code, type_key, label, description, severity_default, is_mandatory,
  default_channels, supported_channels, template_key
)
VALUES
  ('BILLING', 'TRIAL_ENDING_D3', 'Trial termina em 3 dias',
   'Aviso interno D-3 do teste gratuito', 'info', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.trial.ending_d3'),
  ('BILLING', 'TRIAL_ENDING_D2', 'Trial termina em 2 dias',
   'Aviso interno D-2 do teste gratuito', 'info', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.trial.ending_d2'),
  ('BILLING', 'TRIAL_ENDING_D1', 'Trial termina amanhã',
   'Aviso interno D-1 do teste gratuito', 'warning', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.trial.ending_d1'),
  ('BILLING', 'TRIAL_EXPIRED', 'Trial expirado',
   'Aviso interno de trial expirado com restrição', 'warning', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.trial.expired')
ON CONFLICT (category_code, type_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  severity_default = EXCLUDED.severity_default,
  default_channels = EXCLUDED.default_channels,
  supported_channels = EXCLUDED.supported_channels,
  template_key = EXCLUDED.template_key,
  is_active = TRUE;

-- 2) Ledger atômico de transições (alertas + expire + restore)
CREATE TABLE IF NOT EXISTS public.billing_trial_lifecycle_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  trial_end_civil DATE NOT NULL,
  kind TEXT NOT NULL,
  correlation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_trial_lifecycle_transitions_kind_chk CHECK (
    kind IN (
      'ALERT_D3', 'ALERT_D2', 'ALERT_D1', 'ALERT_EXPIRED',
      'EXPIRE_RESTRICTED', 'RESTORE_PAID'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_trial_lifecycle_transitions_uq
  ON public.billing_trial_lifecycle_transitions (user_id, trial_end_civil, kind);

CREATE INDEX IF NOT EXISTS billing_trial_lifecycle_transitions_user_created_idx
  ON public.billing_trial_lifecycle_transitions (user_id, created_at DESC);

COMMENT ON TABLE public.billing_trial_lifecycle_transitions IS
  'S1.HF.6.9A.11A — ledger idempotente multi-instância do ciclo trial';

ALTER TABLE public.billing_trial_lifecycle_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_trial_lifecycle_transitions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.billing_trial_lifecycle_transitions TO service_role;

-- 3) Lock distribuído do job (cron × HTTP)
CREATE TABLE IF NOT EXISTS public.billing_trial_lifecycle_job_locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.billing_trial_lifecycle_job_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_trial_lifecycle_job_locks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_trial_lifecycle_job_locks TO service_role;

CREATE OR REPLACE FUNCTION public.billing_trial_lifecycle_try_acquire_job_lock(
  p_lock_key TEXT,
  p_owner TEXT,
  p_ttl_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_ttl INTEGER := GREATEST(COALESCE(p_ttl_seconds, 120), 30);
  v_row public.billing_trial_lifecycle_job_locks%ROWTYPE;
BEGIN
  IF p_lock_key IS NULL OR btrim(p_lock_key) = '' OR p_owner IS NULL OR btrim(p_owner) = '' THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_input');
  END IF;

  DELETE FROM public.billing_trial_lifecycle_job_locks
  WHERE lock_key = p_lock_key AND expires_at < v_now;

  INSERT INTO public.billing_trial_lifecycle_job_locks (lock_key, owner, acquired_at, expires_at)
  VALUES (p_lock_key, p_owner, v_now, v_now + make_interval(secs => v_ttl))
  ON CONFLICT (lock_key) DO NOTHING;

  SELECT * INTO v_row
  FROM public.billing_trial_lifecycle_job_locks
  WHERE lock_key = p_lock_key;

  IF v_row.owner = p_owner THEN
    RETURN jsonb_build_object('acquired', true, 'reason', 'acquired', 'owner', v_row.owner);
  END IF;

  RETURN jsonb_build_object(
    'acquired', false,
    'reason', 'lock_held',
    'owner', v_row.owner,
    'expires_at', v_row.expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_trial_lifecycle_release_job_lock(
  p_lock_key TEXT,
  p_owner TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.billing_trial_lifecycle_job_locks
  WHERE lock_key = p_lock_key AND owner = p_owner;
  RETURN jsonb_build_object('released', true);
END;
$$;

REVOKE ALL ON FUNCTION public.billing_trial_lifecycle_try_acquire_job_lock(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_trial_lifecycle_release_job_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_trial_lifecycle_try_acquire_job_lock(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_trial_lifecycle_release_job_lock(TEXT, TEXT) TO service_role;

-- 4) Transição atômica expire/restore (advisory lock + ledger + CAS metadata)
CREATE OR REPLACE FUNCTION public.billing_trial_lifecycle_apply_transition(
  p_user_id UUID,
  p_kind TEXT,
  p_trial_end_civil DATE,
  p_paid_confirmed BOOLEAN DEFAULT FALSE,
  p_correlation_id TEXT DEFAULT NULL,
  p_overlay_provider TEXT DEFAULT 'suse7_entitlement',
  p_overlay_status TEXT DEFAULT 'entitlement_only'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key BIGINT;
  v_insert_count INTEGER := 0;
  v_claimed BOOLEAN := FALSE;
  v_overlay public.billing_subscriptions%ROWTYPE;
  v_meta JSONB;
  v_access_owner TEXT;
  v_hard_pause_owner TEXT;
BEGIN
  IF p_user_id IS NULL OR p_kind IS NULL OR p_trial_end_civil IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;

  -- Advisory lock por usuário (multi-instância) — md5→bigint (compatível PG13+)
  v_lock_key := ('x' || substr(md5(p_user_id::text || ':trial_lifecycle'), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  INSERT INTO public.billing_trial_lifecycle_transitions (
    user_id, trial_end_civil, kind, correlation_id, payload
  )
  VALUES (
    p_user_id, p_trial_end_civil, p_kind, p_correlation_id,
    jsonb_build_object('paid_confirmed', COALESCE(p_paid_confirmed, FALSE))
  )
  ON CONFLICT (user_id, trial_end_civil, kind) DO NOTHING;

  GET DIAGNOSTICS v_insert_count = ROW_COUNT;
  v_claimed := v_insert_count > 0;

  SELECT * INTO v_overlay
  FROM public.billing_subscriptions
  WHERE user_id = p_user_id
    AND provider = p_overlay_provider
    AND status = p_overlay_status
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_overlay.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', v_claimed,
      'idempotent', NOT v_claimed,
      'winner', 'overlay_missing'
    );
  END IF;

  v_meta := COALESCE(v_overlay.metadata, '{}'::jsonb);
  v_hard_pause_owner := COALESCE(v_meta->>'hard_pause_owner', '');

  -- Pagamento confirmado sempre vence expiração (corrida A/B).
  IF COALESCE(p_paid_confirmed, FALSE) OR p_kind = 'RESTORE_PAID' THEN
    v_access_owner := COALESCE(v_meta->>'access_owner', '');
    IF v_access_owner = 'TRIAL_LIFECYCLE_ENGINE'
       AND COALESCE(v_meta->>'access_restriction_reason', '') = 'TRIAL_EXPIRED' THEN
      v_meta := v_meta - 'access_owner' - 'access_restriction_reason';
      IF COALESCE(v_meta->>'access_profile', '') = 'EXECUTIVE_ONLY' THEN
        v_meta := jsonb_set(v_meta, '{access_profile}', '"FULL_ACCESS"');
      END IF;
    END IF;

    v_meta := jsonb_set(v_meta, '{trial_state}', '"CONVERTED"');
    v_meta := jsonb_set(v_meta, '{effective_entitlement}', '"PAID_PLAN"');
    v_meta := jsonb_set(v_meta, '{effective_entitlement_source}', '"SUBSCRIPTION_ACTIVE"');
    v_meta := jsonb_set(v_meta, '{suspension_fallback_active}', 'false');
    v_meta := jsonb_set(v_meta, '{sync_state}', '"FULL"');

    -- Nunca remover hard_pause_owner de outro motor.
    IF v_hard_pause_owner <> '' THEN
      v_meta := jsonb_set(v_meta, '{hard_pause_owner}', to_jsonb(v_hard_pause_owner));
    END IF;

    UPDATE public.billing_subscriptions
    SET metadata = v_meta, updated_at = NOW()
    WHERE id = v_overlay.id;

    RETURN jsonb_build_object(
      'ok', true,
      'claimed', v_claimed,
      'idempotent', NOT v_claimed,
      'winner', 'PAID_ACTIVE',
      'cleared_owner', 'TRIAL_LIFECYCLE_ENGINE'
    );
  END IF;

  IF p_kind = 'EXPIRE_RESTRICTED' THEN
    IF COALESCE(v_meta->>'trial_state', '') = 'EXPIRED'
       AND COALESCE(v_meta->>'effective_entitlement', '') = 'TRIAL_EXPIRED_RESTRICTED' THEN
      RETURN jsonb_build_object(
        'ok', true,
        'claimed', false,
        'idempotent', true,
        'winner', 'TRIAL_EXPIRED_RESTRICTED'
      );
    END IF;

    v_meta := v_meta
      || jsonb_build_object(
        'trial_state', 'EXPIRED',
        'trial_consumed', true,
        'trial_expired_at', NOW(),
        'effective_entitlement', 'TRIAL_EXPIRED_RESTRICTED',
        'effective_entitlement_source', 'TRIAL_LIFECYCLE_EXPIRATION',
        'suspension_fallback_active', false,
        'access_profile', 'EXECUTIVE_ONLY',
        'access_restriction_reason', 'TRIAL_EXPIRED',
        'access_owner', 'TRIAL_LIFECYCLE_ENGINE',
        'sync_state', 'FULL'
      );

    UPDATE public.billing_subscriptions
    SET metadata = v_meta, updated_at = NOW()
    WHERE id = v_overlay.id;

    RETURN jsonb_build_object(
      'ok', true,
      'claimed', v_claimed,
      'idempotent', NOT v_claimed,
      'winner', 'TRIAL_EXPIRED_RESTRICTED',
      'access_owner', 'TRIAL_LIFECYCLE_ENGINE'
    );
  END IF;

  -- Alert kinds: ledger claim only (evento IN_APP usa unique de s7_notification_events)
  RETURN jsonb_build_object(
    'ok', true,
    'claimed', v_claimed,
    'idempotent', NOT v_claimed,
    'winner', p_kind
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_trial_lifecycle_apply_transition(UUID, TEXT, DATE, BOOLEAN, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_trial_lifecycle_apply_transition(UUID, TEXT, DATE, BOOLEAN, TEXT, TEXT, TEXT)
  TO service_role;
