-- =============================================================================
-- S7 BILLING FASE 3.0 — Revenue Experience + Financial Intelligence (foundation)
-- Append-only timeline, audit logs, notification center, revenue health
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Timeline financeira (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.billing_subscriptions (id) ON DELETE SET NULL,
  payment_id uuid REFERENCES public.billing_payments (id) ON DELETE SET NULL,
  renewal_cycle_id uuid REFERENCES public.billing_renewal_cycles (id) ON DELETE SET NULL,
  seller_company_id uuid,
  event_type text NOT NULL,
  event_source text NOT NULL DEFAULT 'system',
  severity text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  summary text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  correlation_id text,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT billing_timeline_events_severity_chk
    CHECK (severity IN ('info', 'warning', 'danger', 'critical'))
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_timeline_events_idempotency_uidx
  ON public.billing_timeline_events (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE INDEX IF NOT EXISTS billing_timeline_events_user_occurred_idx
  ON public.billing_timeline_events (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS billing_timeline_events_subscription_idx
  ON public.billing_timeline_events (subscription_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS billing_timeline_events_event_type_idx
  ON public.billing_timeline_events (event_type);

COMMENT ON TABLE public.billing_timeline_events IS
  'Fase 3.0: timeline financeira append-only do seller (fonte de verdade para histórico UX).';

-- ---------------------------------------------------------------------------
-- 2) Audit logs financeiros (imutável)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES public.billing_subscriptions (id) ON DELETE SET NULL,
  payment_id uuid REFERENCES public.billing_payments (id) ON DELETE SET NULL,
  renewal_cycle_id uuid REFERENCES public.billing_renewal_cycles (id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  source text NOT NULL DEFAULT 'billing',
  correlation_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT billing_audit_logs_actor_type_chk
    CHECK (actor_type IN ('seller', 'system', 'job', 'webhook', 'admin', 'provider'))
);

CREATE INDEX IF NOT EXISTS billing_audit_logs_user_created_idx
  ON public.billing_audit_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_audit_logs_action_idx
  ON public.billing_audit_logs (action);

CREATE INDEX IF NOT EXISTS billing_audit_logs_correlation_idx
  ON public.billing_audit_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE public.billing_audit_logs IS
  'Fase 3.0: trilha de auditoria financeira (before/after, sem secrets).';

-- ---------------------------------------------------------------------------
-- 3) Notification center — templates + dispatches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  category text NOT NULL DEFAULT 'billing',
  locale text NOT NULL DEFAULT 'pt-BR',
  channel text NOT NULL DEFAULT 'in_app',
  subject_template text NOT NULL,
  body_template text NOT NULL,
  variables_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT billing_notification_templates_channel_chk
    CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push')),
  CONSTRAINT billing_notification_templates_unique_key_locale_channel
    UNIQUE (template_key, locale, channel)
);

CREATE TABLE IF NOT EXISTS public.billing_notification_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  template_key text NOT NULL,
  channel text NOT NULL DEFAULT 'in_app',
  status text NOT NULL DEFAULT 'pending',
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_subject text,
  rendered_body text,
  timeline_event_id uuid REFERENCES public.billing_timeline_events (id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES public.billing_subscriptions (id) ON DELETE SET NULL,
  scheduled_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  correlation_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT billing_notification_dispatches_status_chk
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT billing_notification_dispatches_channel_chk
    CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push'))
);

CREATE INDEX IF NOT EXISTS billing_notification_dispatches_user_created_idx
  ON public.billing_notification_dispatches (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_notification_dispatches_status_idx
  ON public.billing_notification_dispatches (status, scheduled_at);

-- ---------------------------------------------------------------------------
-- 4) Revenue health (snapshot por seller — recomputável)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_revenue_health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  health_level text NOT NULL,
  health_score numeric(5, 2) NOT NULL DEFAULT 100,
  factors jsonb NOT NULL DEFAULT '{}'::jsonb,
  subscription_id uuid REFERENCES public.billing_subscriptions (id) ON DELETE SET NULL,
  computed_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT billing_revenue_health_level_chk
    CHECK (health_level IN ('HEALTHY', 'WARNING', 'RISK', 'CRITICAL'))
);

CREATE INDEX IF NOT EXISTS billing_revenue_health_user_computed_idx
  ON public.billing_revenue_health_snapshots (user_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- 5) Analytics platform cache (contratos MRR/ARR/churn — job futuro)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL,
  metric_key text NOT NULL,
  metric_value numeric(18, 4) NOT NULL DEFAULT 0,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT billing_analytics_snapshots_unique
    UNIQUE (snapshot_date, metric_key, dimensions)
);

CREATE INDEX IF NOT EXISTS billing_analytics_snapshots_date_metric_idx
  ON public.billing_analytics_snapshots (snapshot_date DESC, metric_key);

-- ---------------------------------------------------------------------------
-- RLS (seller lê próprio; service role escreve)
-- ---------------------------------------------------------------------------
ALTER TABLE public.billing_timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_notification_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_revenue_health_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_timeline_events_select_own ON public.billing_timeline_events;
CREATE POLICY billing_timeline_events_select_own ON public.billing_timeline_events
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_audit_logs_select_own ON public.billing_audit_logs;
CREATE POLICY billing_audit_logs_select_own ON public.billing_audit_logs
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_notification_dispatches_select_own ON public.billing_notification_dispatches;
CREATE POLICY billing_notification_dispatches_select_own ON public.billing_notification_dispatches
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_revenue_health_select_own ON public.billing_revenue_health_snapshots;
CREATE POLICY billing_revenue_health_select_own ON public.billing_revenue_health_snapshots
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Templates: leitura autenticada (conteúdo não sensível)
ALTER TABLE public.billing_notification_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_notification_templates_select_active ON public.billing_notification_templates;
CREATE POLICY billing_notification_templates_select_active ON public.billing_notification_templates
  FOR SELECT TO authenticated
  USING (is_active = true);

-- ---------------------------------------------------------------------------
-- Seed templates (pt-BR, in_app) — variáveis Mustache-like {{var}}
-- ---------------------------------------------------------------------------
INSERT INTO public.billing_notification_templates (
  template_key, category, locale, channel, subject_template, body_template, variables_schema
) VALUES
  (
    'renewal.reminder_3_days',
    'renewal',
    'pt-BR',
    'in_app',
    'Renovação em 3 dias',
    'Seu plano {{plan_name}} vence em breve. Renove para manter monitoramentos e automações ativos.',
    '{"required":["plan_name"]}'::jsonb
  ),
  (
    'renewal.reminder_2_days',
    'renewal',
    'pt-BR',
    'in_app',
    'Faltam 2 dias para a renovação',
    'Evite interrupções no Suse7. Renove o plano {{plan_name}}.',
    '{"required":["plan_name"]}'::jsonb
  ),
  (
    'renewal.reminder_1_day',
    'renewal',
    'pt-BR',
    'in_app',
    'Seu plano vence amanhã',
    'Renove o plano {{plan_name}} para manter seu acesso ativo.',
    '{"required":["plan_name"]}'::jsonb
  ),
  (
    'renewal.due_today',
    'renewal',
    'pt-BR',
    'in_app',
    'Renovação hoje',
    'Hoje é o vencimento do plano {{plan_name}}. Regularize para continuar operando.',
    '{"required":["plan_name"]}'::jsonb
  ),
  (
    'payment.failed',
    'payment',
    'pt-BR',
    'in_app',
    'Falha no pagamento',
    'Não foi possível confirmar o pagamento do plano {{plan_name}}. Atualize sua forma de pagamento.',
    '{"required":["plan_name"]}'::jsonb
  ),
  (
    'grace.started',
    'grace',
    'pt-BR',
    'in_app',
    'Período de tolerância iniciado',
    'Seu plano {{plan_name}} está em tolerância até {{grace_ends_at}}. Renove para evitar bloqueio.',
    '{"required":["plan_name","grace_ends_at"]}'::jsonb
  ),
  (
    'subscription.suspended',
    'suspension',
    'pt-BR',
    'in_app',
    'Assinatura suspensa',
    'Sua assinatura foi suspensa por inadimplência. Regularize para reativar o acesso.',
    '{"required":[]}'::jsonb
  ),
  (
    'payment.confirmed',
    'payment',
    'pt-BR',
    'in_app',
    'Pagamento confirmado',
    'Recebemos o pagamento do plano {{plan_name}}. Obrigado por continuar no Suse7.',
    '{"required":["plan_name"]}'::jsonb
  ),
  (
    'plan.changed',
    'plan',
    'pt-BR',
    'in_app',
    'Mudança de plano',
    'Solicitação de mudança para o plano {{target_plan_name}} registrada ({{change_mode}}).',
    '{"required":["target_plan_name","change_mode"]}'::jsonb
  ),
  (
    'limit.reached',
    'usage',
    'pt-BR',
    'in_app',
    'Limite do plano atingido',
    'Você atingiu o limite de {{limit_label}} do plano {{plan_name}}.',
    '{"required":["plan_name","limit_label"]}'::jsonb
  )
ON CONFLICT (template_key, locale, channel) DO NOTHING;
