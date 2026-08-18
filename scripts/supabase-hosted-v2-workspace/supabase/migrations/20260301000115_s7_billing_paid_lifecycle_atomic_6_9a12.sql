-- =============================================================================
-- S1.HF.6.9A.12 — Paid subscription lifecycle (atomic ledger + job lock + RPC)
-- NÃO EXECUTAR nesta missão (somente preparado / PARADA).
-- Compatível com 6.9A.11A (trial ledger permanece independente).
-- =============================================================================

-- 1) Seeds dos type_key (FK de s7_notification_events)
INSERT INTO public.s7_notification_event_types (
  category_code, type_key, label, description, severity_default, is_mandatory,
  default_channels, supported_channels, template_key
)
VALUES
  ('BILLING', 'RENEWAL_AVAILABLE', 'Renovação disponível',
   'Aviso interno de renovação mensal disponível', 'info', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.renewal.available'),
  ('BILLING', 'PAYMENT_PENDING', 'Pagamento pendente',
   'Cobrança criada aguardando confirmação oficial', 'info', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.payment.pending'),
  ('BILLING', 'PAYMENT_DUE', 'Mensalidade vence hoje',
   'Vencimento civil da competência', 'warning', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.payment.due'),
  ('BILLING', 'GRACE_LAST_DAY', 'Último dia da carência',
   'D10 da carência financeira de 10 dias', 'warning', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.grace.last_day'),
  ('BILLING', 'BABY_FALLBACK_ACTIVATED', 'Fallback Baby ativado',
   'Suspensão financeira com entitlement Baby', 'warning', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.baby.fallback_activated'),
  ('BILLING', 'PAYMENT_CONFIRMED', 'Pagamento confirmado',
   'Pagamento oficial confirmado', 'info', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.payment.confirmed'),
  ('BILLING', 'ENTERED_GRACE', 'Entrou em carência',
   'Início da carência financeira', 'warning', TRUE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.grace.started'),
  ('BILLING', 'SUSPENDED', 'Assinatura suspensa',
   'Suspensão por inadimplência financeira', 'critical', TRUE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.subscription.suspended'),
  ('BILLING', 'REACTIVATED', 'Assinatura reativada',
   'Reativação após pagamento confirmado', 'info', FALSE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.subscription.reactivated'),
  ('BILLING', 'PAYMENT_FAILED', 'Falha de pagamento',
   'Tentativa de pagamento falhou', 'warning', TRUE,
   '["in_app"]'::jsonb, '["in_app"]'::jsonb, 'billing.payment.failed')
ON CONFLICT (category_code, type_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  severity_default = EXCLUDED.severity_default,
  default_channels = EXCLUDED.default_channels,
  supported_channels = EXCLUDED.supported_channels,
  template_key = EXCLUDED.template_key,
  is_active = TRUE;

-- 2) Ledger atômico de eventos do ciclo pago
CREATE TABLE IF NOT EXISTS public.billing_paid_lifecycle_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL DEFAULT '',
  provider_payment_id TEXT NOT NULL DEFAULT '',
  canonical_subscription_id UUID NOT NULL,
  competence_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  correlation_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_paid_lifecycle_ledger_uq UNIQUE (identity_key)
);

CREATE INDEX IF NOT EXISTS billing_paid_lifecycle_ledger_sub_created_idx
  ON public.billing_paid_lifecycle_ledger (canonical_subscription_id, created_at DESC);

COMMENT ON TABLE public.billing_paid_lifecycle_ledger IS
  'S1.HF.6.9A.12 — ledger idempotente multi-instância do ciclo pago';

ALTER TABLE public.billing_paid_lifecycle_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_paid_lifecycle_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.billing_paid_lifecycle_ledger TO service_role;

-- 3) Lock distribuído do reconciler
CREATE TABLE IF NOT EXISTS public.billing_paid_lifecycle_job_locks (
  lock_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.billing_paid_lifecycle_job_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_paid_lifecycle_job_locks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_paid_lifecycle_job_locks TO service_role;

CREATE OR REPLACE FUNCTION public.billing_paid_lifecycle_try_acquire_job_lock(
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
  v_row public.billing_paid_lifecycle_job_locks%ROWTYPE;
BEGIN
  IF p_lock_key IS NULL OR btrim(p_lock_key) = '' OR p_owner IS NULL OR btrim(p_owner) = '' THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'invalid_input');
  END IF;

  DELETE FROM public.billing_paid_lifecycle_job_locks
  WHERE lock_key = p_lock_key AND expires_at < v_now;

  INSERT INTO public.billing_paid_lifecycle_job_locks (lock_key, owner, acquired_at, expires_at)
  VALUES (p_lock_key, p_owner, v_now, v_now + make_interval(secs => v_ttl))
  ON CONFLICT (lock_key) DO NOTHING;

  SELECT * INTO v_row
  FROM public.billing_paid_lifecycle_job_locks
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

CREATE OR REPLACE FUNCTION public.billing_paid_lifecycle_release_job_lock(
  p_lock_key TEXT,
  p_owner TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.billing_paid_lifecycle_job_locks
  WHERE lock_key = p_lock_key AND owner = p_owner;
  RETURN jsonb_build_object('released', true);
END;
$$;

REVOKE ALL ON FUNCTION public.billing_paid_lifecycle_try_acquire_job_lock(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_paid_lifecycle_release_job_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_paid_lifecycle_try_acquire_job_lock(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_paid_lifecycle_release_job_lock(TEXT, TEXT) TO service_role;

-- 4) Transição atômica (advisory lock + ledger)
CREATE OR REPLACE FUNCTION public.billing_paid_lifecycle_apply_transition(
  p_provider TEXT,
  p_provider_event_id TEXT,
  p_provider_payment_id TEXT,
  p_canonical_subscription_id UUID,
  p_competence_key TEXT,
  p_event_type TEXT,
  p_paid_confirmed BOOLEAN DEFAULT FALSE,
  p_correlation_id TEXT DEFAULT NULL
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
  v_sub public.billing_subscriptions%ROWTYPE;
  v_winner TEXT := NULL;
BEGIN
  IF p_provider IS NULL OR p_canonical_subscription_id IS NULL
     OR p_competence_key IS NULL OR p_event_type IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
  END IF;

  v_lock_key := ('x' || substr(md5(p_canonical_subscription_id::text || ':paid_lifecycle'), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  INSERT INTO public.billing_paid_lifecycle_ledger (
    provider, provider_event_id, provider_payment_id,
    canonical_subscription_id, competence_key, event_type,
    identity_key, correlation_id, payload
  )
  VALUES (
    p_provider,
    COALESCE(p_provider_event_id, ''),
    COALESCE(p_provider_payment_id, ''),
    p_canonical_subscription_id,
    p_competence_key,
    p_event_type,
    p_provider || '|' || COALESCE(p_provider_event_id, '') || '|' ||
      COALESCE(p_provider_payment_id, '') || '|' ||
      p_canonical_subscription_id::text || '|' ||
      p_competence_key || '|' || p_event_type,
    p_correlation_id,
    jsonb_build_object('paid_confirmed', COALESCE(p_paid_confirmed, FALSE))
  )
  ON CONFLICT (identity_key) DO NOTHING;

  GET DIAGNOSTICS v_insert_count = ROW_COUNT;
  v_claimed := v_insert_count > 0;

  SELECT * INTO v_sub
  FROM public.billing_subscriptions
  WHERE id = p_canonical_subscription_id
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', v_claimed,
      'idempotent', NOT v_claimed,
      'winner', 'subscription_missing'
    );
  END IF;

  -- Pagamento confirmado vence corrida com suspensão (somente claim; patch Node aplica owner).
  IF COALESCE(p_paid_confirmed, FALSE) THEN
    v_winner := 'PAID_REACTIVATED_OR_SCHEDULED';
  ELSIF p_event_type = 'SUSPEND' THEN
    v_winner := 'PAID_SUSPENDED';
  ELSE
    v_winner := p_event_type;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', v_claimed,
    'idempotent', NOT v_claimed,
    'winner', v_winner,
    'canonical_subscription_id', p_canonical_subscription_id,
    'competence_key', p_competence_key,
    'clear_owner', CASE WHEN COALESCE(p_paid_confirmed, FALSE)
      THEN 'PAYMENT_DELINQUENCY_ENGINE' ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_paid_lifecycle_apply_transition(
  TEXT, TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_paid_lifecycle_apply_transition(
  TEXT, TEXT, TEXT, UUID, TEXT, TEXT, BOOLEAN, TEXT
) TO service_role;

COMMENT ON FUNCTION public.billing_paid_lifecycle_apply_transition IS
  'S1.HF.6.9A.12 — claim atômico do ledger pago + advisory lock por assinatura canônica';
