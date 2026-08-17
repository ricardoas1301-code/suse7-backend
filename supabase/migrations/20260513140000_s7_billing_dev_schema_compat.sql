-- S7 BILLING 03.5 — compatibilidade DEV com contrato do backend (idempotente)
-- O Supabase DEV já tinha colunas legadas (ex.: billing_customer_id, billing_subscription_id).
-- Este patch só adiciona o que o motor BILLING 03 usa via PostgREST, sem remover colunas existentes.

CREATE TABLE IF NOT EXISTS public.billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text,
  raw_payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'received',
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS billing_events_processing_status_idx ON public.billing_events (processing_status);
CREATE INDEX IF NOT EXISTS billing_events_created_at_idx ON public.billing_events (created_at DESC);

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS plan_key text,
  ADD COLUMN IF NOT EXISTS provider_customer_id text,
  ADD COLUMN IF NOT EXISTS amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS next_due_date date,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

CREATE INDEX IF NOT EXISTS billing_subscriptions_plan_key_idx ON public.billing_subscriptions (plan_key);
CREATE INDEX IF NOT EXISTS billing_subscriptions_provider_sub_idx ON public.billing_subscriptions (provider, provider_subscription_id);

ALTER TABLE public.billing_payments
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES public.billing_subscriptions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS event_type_snapshot text,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;

CREATE INDEX IF NOT EXISTS billing_payments_subscription_id_idx ON public.billing_payments (subscription_id);

COMMENT ON COLUMN public.billing_subscriptions.provider_customer_id IS 'ID do cliente no gateway (Asaas). Convive com billing_customer_id legado no DEV.';
COMMENT ON COLUMN public.billing_payments.subscription_id IS 'FK canônica BILLING 03; convive com billing_subscription_id legado no DEV.';
