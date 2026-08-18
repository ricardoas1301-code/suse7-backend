-- =============================================================================
-- S7 Central Notification Engine — Fase 3.1
-- Motor central: eventos, preferências, destinatários, templates, dispatches
-- =============================================================================

-- Categorias oficiais
CREATE TABLE IF NOT EXISTS public.s7_notification_categories (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.s7_notification_categories (code, label, description, sort_order)
VALUES
  ('BILLING', 'Billing', 'Assinatura, pagamentos e renovações', 10),
  ('PRODUCTS', 'Produtos', 'Catálogo e cadastro de produtos', 20),
  ('INVENTORY', 'Estoque', 'Estoque e disponibilidade', 30),
  ('SALES', 'Vendas', 'Pedidos e vendas', 40),
  ('PROFIT', 'Lucro', 'Margem, prejuízo e rentabilidade', 50),
  ('MARKETPLACE', 'Marketplace', 'Integrações e saúde de marketplace', 60),
  ('ACCOUNT_HEALTH', 'Saúde da conta', 'Conta, limites e bloqueios', 70),
  ('COMPETITION', 'Concorrência', 'Concorrência e posicionamento', 80),
  ('SYNC', 'Sincronização', 'Jobs e sincronização de dados', 90),
  ('SYSTEM', 'Sistema', 'Alertas operacionais da plataforma', 100),
  ('DEVCENTER', 'DevCenter', 'Observabilidade interna', 110)
ON CONFLICT (code) DO NOTHING;

-- Tipos por categoria (catálogo canônico)
CREATE TABLE IF NOT EXISTS public.s7_notification_event_types (
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  severity_default TEXT NOT NULL DEFAULT 'info',
  is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  default_channels JSONB NOT NULL DEFAULT '["in_app","email"]'::jsonb,
  supported_channels JSONB NOT NULL DEFAULT '["in_app","email","whatsapp"]'::jsonb,
  template_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category_code, type_key)
);

INSERT INTO public.s7_notification_event_types (
  category_code, type_key, label, description, severity_default, is_mandatory, default_channels, template_key
)
VALUES
  ('BILLING', 'PAYMENT_CONFIRMED', 'Pagamento confirmado', 'Pagamento confirmado com sucesso', 'info', FALSE, '["in_app","email"]', 'billing.payment.confirmed'),
  ('BILLING', 'PAYMENT_FAILED', 'Pagamento falhou', 'Falha ou atraso de pagamento', 'warning', TRUE, '["in_app","email","whatsapp"]', 'billing.payment.failed'),
  ('BILLING', 'PAYMENT_GENERATED', 'Cobrança gerada', 'Nova cobrança registrada', 'info', FALSE, '["in_app"]', 'billing.payment.generated'),
  ('BILLING', 'SUSPENDED', 'Assinatura suspensa', 'Assinatura suspensa por inadimplência', 'critical', TRUE, '["in_app","email","whatsapp"]', 'billing.subscription.suspended'),
  ('BILLING', 'REACTIVATED', 'Assinatura reativada', 'Acesso regularizado após pagamento', 'info', FALSE, '["in_app","email"]', 'billing.subscription.reactivated'),
  ('BILLING', 'ENTERED_GRACE', 'Período de carência', 'Entrada em período de carência', 'warning', TRUE, '["in_app","email","whatsapp"]', 'billing.grace.started'),
  ('BILLING', 'RENEWAL_COMPLETED', 'Renovação concluída', 'Ciclo de renovação quitado', 'info', FALSE, '["in_app"]', 'billing.renewal.completed'),
  ('ACCOUNT_HEALTH', 'MARKETPLACE_DISCONNECTED', 'Conta desconectada', 'Conta marketplace desconectada criticamente', 'critical', TRUE, '["in_app","email","whatsapp"]', 'account.marketplace.disconnected')
ON CONFLICT (category_code, type_key) DO NOTHING;

-- Event bus (append-only, idempotente)
CREATE TABLE IF NOT EXISTS public.s7_notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT,
  idempotency_key TEXT NOT NULL,
  marketplace TEXT,
  marketplace_account_id UUID,
  seller_company_id UUID,
  entity_type TEXT,
  entity_id TEXT,
  source_module TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_events_category_type_fk
    FOREIGN KEY (category_code, type_key)
    REFERENCES public.s7_notification_event_types (category_code, type_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS s7_notification_events_seller_idempotency_uq
  ON public.s7_notification_events (seller_id, idempotency_key);

CREATE INDEX IF NOT EXISTS s7_notification_events_seller_created_idx
  ON public.s7_notification_events (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS s7_notification_events_category_created_idx
  ON public.s7_notification_events (category_code, created_at DESC);

-- Preferências: seller × categoria × tipo × canal
CREATE TABLE IF NOT EXISTS public.s7_notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT,
  channel TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_preferences_channel_chk
    CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push')),
  CONSTRAINT s7_notification_preferences_scope_uq
    UNIQUE (seller_id, category_code, type_key, channel)
);

CREATE INDEX IF NOT EXISTS s7_notification_preferences_seller_idx
  ON public.s7_notification_preferences (seller_id, category_code);

-- Destinatários
CREATE TABLE IF NOT EXISTS public.s7_notification_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  channel TEXT NOT NULL,
  destination TEXT NOT NULL,
  label TEXT,
  role_tag TEXT,
  contact_id UUID,
  marketplace_account_id UUID,
  seller_company_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_recipients_channel_chk
    CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push'))
);

CREATE INDEX IF NOT EXISTS s7_notification_recipients_seller_channel_idx
  ON public.s7_notification_recipients (seller_id, channel) WHERE is_active = TRUE;

-- Escopo de categorias/tipos por destinatário
CREATE TABLE IF NOT EXISTS public.s7_notification_recipient_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES public.s7_notification_recipients (id) ON DELETE CASCADE,
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_recipient_scopes_uq
    UNIQUE (recipient_id, category_code, type_key)
);

-- Templates centralizados
CREATE TABLE IF NOT EXISTS public.s7_notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key TEXT NOT NULL,
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT,
  channel TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'pt-BR',
  priority TEXT NOT NULL DEFAULT 'normal',
  subject_template TEXT NOT NULL DEFAULT '',
  body_template TEXT NOT NULL,
  variables_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_templates_channel_chk
    CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push')),
  CONSTRAINT s7_notification_templates_key_channel_locale_uq
    UNIQUE (template_key, channel, locale)
);

-- Dispatches do motor central
CREATE TABLE IF NOT EXISTS public.s7_notification_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.s7_notification_events (id) ON DELETE CASCADE,
  seller_id UUID NOT NULL,
  template_id UUID REFERENCES public.s7_notification_templates (id),
  template_key TEXT,
  recipient_id UUID REFERENCES public.s7_notification_recipients (id),
  channel TEXT NOT NULL,
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority TEXT NOT NULL DEFAULT 'normal',
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  rendered_subject TEXT,
  rendered_body TEXT,
  provider_key TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  correlation_id TEXT,
  source_module TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  queued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_dispatches_status_chk
    CHECK (status IN ('PENDING', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED')),
  CONSTRAINT s7_notification_dispatches_channel_chk
    CHECK (channel IN ('in_app', 'email', 'whatsapp', 'push'))
);

CREATE INDEX IF NOT EXISTS s7_notification_dispatches_seller_created_idx
  ON public.s7_notification_dispatches (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS s7_notification_dispatches_event_idx
  ON public.s7_notification_dispatches (event_id);

CREATE INDEX IF NOT EXISTS s7_notification_dispatches_status_created_idx
  ON public.s7_notification_dispatches (status, created_at DESC);

-- Logs de entrega (auditoria / DevCenter)
CREATE TABLE IF NOT EXISTS public.s7_notification_delivery_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES public.s7_notification_dispatches (id) ON DELETE CASCADE,
  attempt_number INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  provider_key TEXT,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS s7_notification_delivery_logs_dispatch_idx
  ON public.s7_notification_delivery_logs (dispatch_id, created_at DESC);

-- Templates billing (motor central — não substitui billing_notification_*)
INSERT INTO public.s7_notification_templates (
  template_key, category_code, type_key, channel, locale, priority, subject_template, body_template
)
VALUES
  ('billing.payment.confirmed', 'BILLING', 'PAYMENT_CONFIRMED', 'in_app', 'pt-BR', 'normal',
   'Pagamento confirmado', 'Seu pagamento do plano {{plan_name}} foi confirmado.'),
  ('billing.payment.confirmed', 'BILLING', 'PAYMENT_CONFIRMED', 'email', 'pt-BR', 'normal',
   'Pagamento confirmado — {{plan_name}}', 'Olá! Confirmamos o pagamento do plano {{plan_name}}.'),
  ('billing.payment.failed', 'BILLING', 'PAYMENT_FAILED', 'in_app', 'pt-BR', 'high',
   'Pagamento em atraso', 'Não identificamos o pagamento do plano {{plan_name}}. Regularize para evitar suspensão.'),
  ('billing.payment.failed', 'BILLING', 'PAYMENT_FAILED', 'email', 'pt-BR', 'high',
   'Pagamento pendente — {{plan_name}}', 'Seu pagamento do plano {{plan_name}} está pendente ou em atraso.'),
  ('billing.payment.failed', 'BILLING', 'PAYMENT_FAILED', 'whatsapp', 'pt-BR', 'high',
   '', 'Suse7: pagamento pendente do plano {{plan_name}}. Acesse o painel para regularizar.'),
  ('billing.payment.generated', 'BILLING', 'PAYMENT_GENERATED', 'in_app', 'pt-BR', 'normal',
   'Cobrança gerada', 'Nova cobrança do plano {{plan_name}} registrada.'),
  ('billing.subscription.suspended', 'BILLING', 'SUSPENDED', 'in_app', 'pt-BR', 'critical',
   'Assinatura suspensa', 'Sua assinatura do plano {{plan_name}} foi suspensa por inadimplência.'),
  ('billing.subscription.suspended', 'BILLING', 'SUSPENDED', 'email', 'pt-BR', 'critical',
   'Assinatura suspensa — {{plan_name}}', 'Sua assinatura foi suspensa. Regularize o pagamento para reativar.'),
  ('billing.subscription.suspended', 'BILLING', 'SUSPENDED', 'whatsapp', 'pt-BR', 'critical',
   '', 'Suse7: assinatura {{plan_name}} suspensa. Regularize no painel.'),
  ('billing.subscription.reactivated', 'BILLING', 'REACTIVATED', 'in_app', 'pt-BR', 'normal',
   'Assinatura reativada', 'Seu acesso ao plano {{plan_name}} foi restabelecido.'),
  ('billing.subscription.reactivated', 'BILLING', 'REACTIVATED', 'email', 'pt-BR', 'normal',
   'Assinatura reativada — {{plan_name}}', 'Pagamento confirmado. Sua assinatura está ativa novamente.'),
  ('billing.grace.started', 'BILLING', 'ENTERED_GRACE', 'in_app', 'pt-BR', 'high',
   'Período de carência', 'Você entrou em carência no plano {{plan_name}} até {{grace_ends_at}}.'),
  ('billing.grace.started', 'BILLING', 'ENTERED_GRACE', 'email', 'pt-BR', 'high',
   'Carência iniciada — {{plan_name}}', 'Período de carência até {{grace_ends_at}}. Regularize antes da suspensão.'),
  ('billing.grace.started', 'BILLING', 'ENTERED_GRACE', 'whatsapp', 'pt-BR', 'high',
   '', 'Suse7: carência no plano {{plan_name}} até {{grace_ends_at}}.'),
  ('billing.renewal.completed', 'BILLING', 'RENEWAL_COMPLETED', 'in_app', 'pt-BR', 'normal',
   'Renovação concluída', 'Renovação do plano {{plan_name}} concluída com sucesso.')
ON CONFLICT (template_key, channel, locale) DO NOTHING;
