-- S7 BILLING 03 — tabelas de cobrança (sem criar `public.plans`: contrato real já existe no Suse7)
-- Se uma versão antiga desta migration chegou a criar `public.plans` genérica, avalie remoção manual
-- após backup — não duplicar catálogo de planos.
-- FK `billing_subscriptions.plan_id` → `public.plans(id)`.

CREATE TABLE IF NOT EXISTS public.billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_customer_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS billing_customers_provider_customer_idx ON public.billing_customers (provider, provider_customer_id);

CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.plans (id),
  provider text NOT NULL,
  provider_customer_id text,
  provider_subscription_id text,
  status text NOT NULL,
  amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'BRL',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_subscriptions_user_idx ON public.billing_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS billing_subscriptions_status_idx ON public.billing_subscriptions (status);

CREATE TABLE IF NOT EXISTS public.billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.billing_subscriptions (id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  status text,
  amount numeric(14, 2),
  currency text NOT NULL DEFAULT 'BRL',
  event_type_snapshot text,
  paid_at timestamptz,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

CREATE INDEX IF NOT EXISTS billing_payments_subscription_idx ON public.billing_payments (subscription_id);

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text,
  payload jsonb NOT NULL,
  processed boolean NOT NULL DEFAULT false,
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_processed_idx ON public.billing_webhook_events (processed);

COMMENT ON TABLE public.billing_webhook_events IS 'Idempotência de webhooks de billing (Asaas, Stripe, etc.).';
