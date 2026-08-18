-- =============================================================================
-- P_2.8.12F.GA — MANUAL_SALES_REPORT ("Compartilhar Relatório de Vendas")
-- + templates WhatsApp / E-mail.
-- Espelha o padrão de MANUAL_SALE_RAYX (20260523120000), reutilizando o
-- motor central (categorias, destinatários e regras de entrega).
-- Compatível com schema Phase 3.1 (coluna severity_default).
-- =============================================================================
--
-- PRÉ-CHECK — listar antes de aplicar (SQL Editor / psql):
--
-- SELECT category_code, type_key, template_key, severity_default, default_channels, supported_channels
-- FROM public.s7_notification_event_types
-- WHERE category_code = 'SALES' AND type_key = 'MANUAL_SALES_REPORT';
--
-- SELECT template_key, channel, locale, is_active
-- FROM public.s7_notification_templates
-- WHERE template_key = 'sales.manual.report'
-- ORDER BY channel, locale;

-- Garante categoria SALES (idempotente; já existe na Phase 3.1)
INSERT INTO public.s7_notification_categories (code, label, description, sort_order)
VALUES ('SALES', 'Vendas', 'Pedidos e vendas', 40)
ON CONFLICT (code) DO NOTHING;

-- Tipo de evento manual "Compartilhar Relatório de Vendas"
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
  'SALES',
  'MANUAL_SALES_REPORT',
  'Compartilhar Relatório de Vendas',
  'Acionamento manual pelo seller a partir do modal Relatório de Vendas',
  'info',
  FALSE,
  '["whatsapp","email"]'::jsonb,
  '["whatsapp","email"]'::jsonb,
  'sales.manual.report',
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

-- Templates WhatsApp + E-mail (mesmo contrato das migrations Phase 3.1 / 3.4.A)
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
    'sales.manual.report',
    'SALES',
    'MANUAL_SALES_REPORT',
    'whatsapp',
    'pt-BR',
    'normal',
    '',
    E'📊 Suse7 — Relatório de Vendas\n\nPeríodo: {{periodo}}\nConta: {{conta}}\nVendas: {{vendas}}\n\nFaturamento: {{faturamento}}\nLucro: {{lucro}}\nMargem: {{margem}}\n\nGerado por Suse7 Precifica\nInteligência em Vendas'
  ),
  (
    'sales.manual.report',
    'SALES',
    'MANUAL_SALES_REPORT',
    'email',
    'pt-BR',
    'normal',
    'Relatório de Vendas — {{periodo}}',
    E'Olá,\n\nSegue o resumo do Relatório de Vendas:\n\nPeríodo: {{periodo}}\nConta: {{conta}}\nVendas: {{vendas}}\n\nFaturamento: {{faturamento}}\nLucro: {{lucro}}\nMargem: {{margem}}\n\nGerado por Suse7 Precifica\nInteligência em Vendas'
  )
ON CONFLICT (template_key, channel, locale) DO UPDATE SET
  category_code = EXCLUDED.category_code,
  type_key = EXCLUDED.type_key,
  priority = EXCLUDED.priority,
  subject_template = EXCLUDED.subject_template,
  body_template = EXCLUDED.body_template,
  is_active = TRUE,
  updated_at = NOW();
