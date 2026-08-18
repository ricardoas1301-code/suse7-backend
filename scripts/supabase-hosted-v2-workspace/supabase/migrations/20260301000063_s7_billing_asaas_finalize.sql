-- S7 BILLING — finalização webhook Asaas (eventos + estado de assinatura)
-- `billing_events` é a trilha canônica de idempotência/auditoria; `billing_webhook_events` permanece legado (BILLING 03).

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

COMMENT ON TABLE public.billing_events IS 'Eventos financeiros recebidos (webhook). Idempotência por (provider, provider_event_id).';

ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS plan_key text,
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS next_due_date date,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

CREATE INDEX IF NOT EXISTS billing_subscriptions_plan_key_idx ON public.billing_subscriptions (plan_key);
CREATE INDEX IF NOT EXISTS billing_subscriptions_provider_sub_idx ON public.billing_subscriptions (provider, provider_subscription_id);
