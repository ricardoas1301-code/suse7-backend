-- =============================================================================
-- Resumo de vendas do dia — regras de automação + execuções idempotentes
-- Evento: SALES:DAILY_SALES_SUMMARY
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.s7_notification_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_successful_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_automation_rules_event_fk
    FOREIGN KEY (category_code, type_key)
    REFERENCES public.s7_notification_event_types (category_code, type_key),
  CONSTRAINT s7_notification_automation_rules_seller_event_uq
    UNIQUE (seller_id, category_code, type_key)
);

CREATE INDEX IF NOT EXISTS s7_notification_automation_rules_enabled_idx
  ON public.s7_notification_automation_rules (enabled, category_code, type_key)
  WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS public.s7_notification_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  category_code TEXT NOT NULL,
  type_key TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  event_id UUID REFERENCES public.s7_notification_events (id),
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT s7_notification_automation_runs_status_chk
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  CONSTRAINT s7_notification_automation_runs_seller_event_slot_uq
    UNIQUE (seller_id, category_code, type_key, scheduled_at)
);

CREATE INDEX IF NOT EXISTS s7_notification_automation_runs_seller_scheduled_idx
  ON public.s7_notification_automation_runs (seller_id, scheduled_at DESC);

ALTER TABLE public.s7_notification_automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s7_notification_automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS s7_notification_automation_rules_seller_select ON public.s7_notification_automation_rules;
DROP POLICY IF EXISTS s7_notification_automation_rules_seller_insert ON public.s7_notification_automation_rules;
DROP POLICY IF EXISTS s7_notification_automation_rules_seller_update ON public.s7_notification_automation_rules;
DROP POLICY IF EXISTS s7_notification_automation_rules_seller_delete ON public.s7_notification_automation_rules;

CREATE POLICY s7_notification_automation_rules_seller_select
  ON public.s7_notification_automation_rules FOR SELECT
  USING (seller_id = auth.uid());

CREATE POLICY s7_notification_automation_rules_seller_insert
  ON public.s7_notification_automation_rules FOR INSERT
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY s7_notification_automation_rules_seller_update
  ON public.s7_notification_automation_rules FOR UPDATE
  USING (seller_id = auth.uid())
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY s7_notification_automation_rules_seller_delete
  ON public.s7_notification_automation_rules FOR DELETE
  USING (seller_id = auth.uid());

-- Atualiza tipo do evento — canais completos + template
UPDATE public.s7_notification_event_types
SET
  default_channels = '["in_app","email","whatsapp","push"]'::jsonb,
  supported_channels = '["in_app","email","whatsapp","push"]'::jsonb,
  template_key = 'sales.daily.summary',
  description = 'Resumo automático de vendas no horário configurado pelo seller'
WHERE category_code = 'SALES' AND type_key = 'DAILY_SALES_SUMMARY';

INSERT INTO public.s7_notification_templates (
  template_key, category_code, type_key, channel, subject_template, body_template
)
VALUES
  (
    'sales.daily.summary',
    'SALES',
    'DAILY_SALES_SUMMARY',
    'in_app',
    'Resumo de vendas — {{periodo}}',
    'Período {{periodo}}: {{vendas}} vendas · Faturamento {{faturamento}} · Lucro {{lucro}} · Margem {{margem}}.'
  ),
  (
    'sales.daily.summary',
    'SALES',
    'DAILY_SALES_SUMMARY',
    'email',
    'Resumo de vendas — {{periodo}}',
    'Olá! Resumo de vendas ({{periodo}}): Vendas {{vendas}} · Faturamento {{faturamento}} · Lucro {{lucro}} · Margem {{margem}}. Conta: {{conta}} — Suse7'
  ),
  (
    'sales.daily.summary',
    'SALES',
    'DAILY_SALES_SUMMARY',
    'whatsapp',
    '',
    'Resumo de vendas ({{periodo}}) — Vendas: {{vendas}} · Faturamento: {{faturamento}} · Lucro: {{lucro}} · Margem: {{margem}}'
  ),
  (
    'sales.daily.summary',
    'SALES',
    'DAILY_SALES_SUMMARY',
    'push',
    'Resumo de vendas',
    '{{periodo}} — {{vendas}} vendas · Lucro {{lucro}}'
  )
ON CONFLICT (template_key, channel, locale) DO UPDATE SET
  body_template = EXCLUDED.body_template,
  subject_template = EXCLUDED.subject_template,
  type_key = EXCLUDED.type_key,
  updated_at = NOW();
