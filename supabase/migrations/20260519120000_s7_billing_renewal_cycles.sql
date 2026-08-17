-- =============================================================================
-- S7 BILLING FASE 2 — billing_renewal_cycles (ciclos oficiais de renovação)
--
-- DIAGNÓSTICO (pré-migration):
--   REAPROVEITADO: billing_subscriptions (período, plano, metadata), billing_payments,
--     billing_payment_methods, billing_events, motor checkout/webhook existente.
--   CRIADO: billing_renewal_cycles + índices + idempotência por ciclo.
--   NÃO ALTERADO NESTA FASE: public.plans, lógica de checkout inicial, Pix automático.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.billing_renewal_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.billing_subscriptions (id) ON DELETE CASCADE,
  current_plan_key text NOT NULL,
  current_plan_id uuid REFERENCES public.plans (id),
  cycle_start timestamptz NOT NULL,
  cycle_end timestamptz NOT NULL,
  renewal_due_date timestamptz NOT NULL,
  renewal_strategy text NOT NULL,
  renewal_status text NOT NULL,
  generated_payment_id uuid REFERENCES public.billing_payments (id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'asaas',
  provider_payment_id text,
  auto_charge_attempted_at timestamptz,
  auto_charge_status text,
  retry_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  grace_period_until timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_renewal_cycles_retry_count_nonneg CHECK (retry_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_renewal_cycles_idempotency_uidx
  ON public.billing_renewal_cycles (
    user_id,
    subscription_id,
    current_plan_key,
    cycle_start,
    cycle_end
  );

CREATE INDEX IF NOT EXISTS billing_renewal_cycles_user_idx ON public.billing_renewal_cycles (user_id);
CREATE INDEX IF NOT EXISTS billing_renewal_cycles_subscription_idx ON public.billing_renewal_cycles (subscription_id);
CREATE INDEX IF NOT EXISTS billing_renewal_cycles_renewal_status_idx ON public.billing_renewal_cycles (renewal_status);
CREATE INDEX IF NOT EXISTS billing_renewal_cycles_renewal_due_date_idx ON public.billing_renewal_cycles (renewal_due_date);
CREATE INDEX IF NOT EXISTS billing_renewal_cycles_cycle_window_idx ON public.billing_renewal_cycles (cycle_start, cycle_end);
CREATE INDEX IF NOT EXISTS billing_renewal_cycles_generated_payment_idx ON public.billing_renewal_cycles (generated_payment_id);
CREATE INDEX IF NOT EXISTS billing_renewal_cycles_provider_payment_idx ON public.billing_renewal_cycles (provider, provider_payment_id);

COMMENT ON TABLE public.billing_renewal_cycles IS
  'Ciclos operacionais de renovação Suse7 — separados de assinatura (fonte de plano) e pagamentos (cobranças).';

ALTER TABLE public.billing_renewal_cycles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_renewal_cycles_select_own ON public.billing_renewal_cycles;
CREATE POLICY billing_renewal_cycles_select_own ON public.billing_renewal_cycles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
