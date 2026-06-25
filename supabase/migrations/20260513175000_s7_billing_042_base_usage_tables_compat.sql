-- BILLING 04.2 — compat DEV: tabelas de limites/uso antes da 04.2.A
-- Idempotente. Use quando 20260513160000 ainda não foi aplicada no ambiente.

CREATE TABLE IF NOT EXISTS public.billing_plan_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  monthly_sales_limit integer,
  warning_threshold_percent integer NOT NULL DEFAULT 80,
  grace_period_days integer NOT NULL DEFAULT 0,
  hard_block_enabled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_plan_limits_plan_id_key UNIQUE (plan_id)
);

CREATE INDEX IF NOT EXISTS billing_plan_limits_plan_id_idx ON public.billing_plan_limits(plan_id);

CREATE TABLE IF NOT EXISTS public.billing_monthly_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  window_kind text NOT NULL DEFAULT 'calendar_month',
  sales_count integer NOT NULL DEFAULT 0,
  seller_company_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_monthly_usage_window_key UNIQUE (user_id, period_start, period_end, window_kind)
);

CREATE INDEX IF NOT EXISTS billing_monthly_usage_user_period_idx
  ON public.billing_monthly_usage(user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS public.billing_usage_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  window_kind text NOT NULL DEFAULT 'calendar_month',
  sales_count integer NOT NULL DEFAULT 0,
  plan_id uuid REFERENCES public.plans(id) ON DELETE SET NULL,
  plan_key text,
  monthly_sales_limit integer,
  usage_percent numeric(6, 2),
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS billing_usage_snapshots_user_captured_idx
  ON public.billing_usage_snapshots(user_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  period_start date,
  period_end date,
  sales_count integer,
  monthly_sales_limit integer,
  usage_percent numeric(6, 2),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_usage_events_user_created_idx
  ON public.billing_usage_events(user_id, created_at DESC);
