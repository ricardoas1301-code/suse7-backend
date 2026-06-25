-- =============================================================================
-- MANUAL_COMPETITION_REPORT — Compartilhar Relatório de Concorrência
-- Espelha MANUAL_SALES_REPORT (20260608171000).
-- =============================================================================

INSERT INTO public.s7_notification_categories (code, label, description, sort_order)
VALUES ('COMPETITION', 'Concorrência', 'Concorrência e posicionamento', 80)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.s7_notification_event_types (
  category_code,
  type_key,
  label,
  description,
  severity_default,
  is_mandatory,
  default_channels,
  supported_channels,
  template_key,
  is_active
)
VALUES (
  'COMPETITION',
  'MANUAL_COMPETITION_REPORT',
  'Relatório de Concorrência',
  'Envio manual de relatório competitivo.',
  'info',
  FALSE,
  '["whatsapp","email"]'::jsonb,
  '["whatsapp","email"]'::jsonb,
  'competition.manual.report',
  TRUE
)
ON CONFLICT (category_code, type_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  severity_default = EXCLUDED.severity_default,
  default_channels = EXCLUDED.default_channels,
  supported_channels = EXCLUDED.supported_channels,
  template_key = EXCLUDED.template_key,
  is_active = TRUE;

INSERT INTO public.s7_notification_templates (
  template_key,
  category_code,
  type_key,
  channel,
  locale,
  priority,
  subject_template,
  body_template
)
VALUES
  (
    'competition.manual.report',
    'COMPETITION',
    'MANUAL_COMPETITION_REPORT',
    'whatsapp',
    'pt-BR',
    'normal',
    '',
    E'📊 Suse7 — Relatório de Concorrência\n\nConta: {{conta}}\nFiltro: {{filtro}}\nProdutos: {{produtos}}\n\nCom concorrentes: {{comConcorrentes}}\nTotal monitorados: {{totalConcorrentes}}\n\nGerado por Suse7 Precifica\nInteligência Competitiva'
  ),
  (
    'competition.manual.report',
    'COMPETITION',
    'MANUAL_COMPETITION_REPORT',
    'email',
    'pt-BR',
    'normal',
    'Relatório de Concorrência — {{conta}}',
    E'Olá,\n\nSegue o resumo do Relatório de Concorrência:\n\nConta: {{conta}}\nFiltro: {{filtro}}\nProdutos: {{produtos}}\n\nCom concorrentes: {{comConcorrentes}}\nTotal de concorrentes monitorados: {{totalConcorrentes}}\n\nGerado por Suse7 Precifica\nInteligência Competitiva'
  )
ON CONFLICT (template_key, channel, locale) DO UPDATE SET
  category_code = EXCLUDED.category_code,
  type_key = EXCLUDED.type_key,
  priority = EXCLUDED.priority,
  subject_template = EXCLUDED.subject_template,
  body_template = EXCLUDED.body_template,
  is_active = TRUE,
  updated_at = NOW();
