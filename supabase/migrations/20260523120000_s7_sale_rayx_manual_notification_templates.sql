-- =============================================================================
-- Fase 3.5C.1.A3 — MANUAL_SALE_RAYX + templates WhatsApp / E-mail
-- Compatível com schema Phase 3.1 (coluna severity_default)
-- =============================================================================
--
-- PRÉ-CHECK — listar colunas reais antes de aplicar (SQL Editor / psql):
--
-- SELECT table_name, column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     's7_notification_categories',
--     's7_notification_event_types',
--     's7_notification_templates'
--   )
-- ORDER BY table_name, ordinal_position;
--
-- SELECT category_code, type_key, template_key, severity_default, default_channels, supported_channels
-- FROM public.s7_notification_event_types
-- WHERE category_code = 'SALES' AND type_key = 'MANUAL_SALE_RAYX';
--
-- SELECT template_key, channel, locale, is_active
-- FROM public.s7_notification_templates
-- WHERE template_key = 'sales.manual.rayx'
-- ORDER BY channel, locale;

-- Garante categoria SALES (idempotente; já existe na Phase 3.1)
INSERT INTO public.s7_notification_categories (code, label, description, sort_order)
VALUES ('SALES', 'Vendas', 'Pedidos e vendas', 40)
ON CONFLICT (code) DO NOTHING;

-- Tipo de evento manual Raio-X (colunas alinhadas a 20260522140000_phase31.sql)
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
  'MANUAL_SALE_RAYX',
  'Compartilhar Raio-X da venda',
  'Acionamento manual pelo seller a partir do modal Raio-X',
  'info',
  FALSE,
  '["whatsapp","email"]'::jsonb,
  '["whatsapp","email"]'::jsonb,
  'sales.manual.rayx',
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
    'sales.manual.rayx',
    'SALES',
    'MANUAL_SALE_RAYX',
    'whatsapp',
    'pt-BR',
    'normal',
    '',
    E'🚨 Suse7 — Raio-X da venda\n\nVenda: #{{sale_id}}\nProduto: {{product_title}}\nCliente: {{buyer_name}}\nValor da venda: R$ {{sale_amount}}\nValor recebido: R$ {{received_amount}}\nLucro: R$ {{profit_amount}}\nMargem: {{margin_percent}}%\nSaúde da venda: {{sale_health}}\n\nVer detalhes:\n{{sale_rayx_url}}'
  ),
  (
    'sales.manual.rayx',
    'SALES',
    'MANUAL_SALE_RAYX',
    'email',
    'pt-BR',
    'normal',
    'Raio-X da venda #{{sale_id}} — {{product_title}}',
    E'Olá,\n\nSegue o resumo do Raio-X da venda:\n\nVenda: #{{sale_id}}\nProduto: {{product_title}}\nCliente: {{buyer_name}}\nValor da venda: R$ {{sale_amount}}\nValor recebido: R$ {{received_amount}}\nLucro: R$ {{profit_amount}}\nMargem: {{margin_percent}}%\nSaúde da venda: {{sale_health}}\n\nVer detalhes: {{sale_rayx_url}}\n\n— Suse7'
  )
ON CONFLICT (template_key, channel, locale) DO UPDATE SET
  category_code = EXCLUDED.category_code,
  type_key = EXCLUDED.type_key,
  priority = EXCLUDED.priority,
  subject_template = EXCLUDED.subject_template,
  body_template = EXCLUDED.body_template,
  is_active = TRUE,
  updated_at = NOW();
