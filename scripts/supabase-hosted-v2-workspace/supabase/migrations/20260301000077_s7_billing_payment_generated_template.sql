-- Fase 3.0.1 — template in-app para cobrança gerada (webhook Asaas)
INSERT INTO public.billing_notification_templates (
  template_key,
  category,
  locale,
  channel,
  subject_template,
  body_template,
  variables_schema
)
VALUES (
  'payment.generated',
  'payment',
  'pt-BR',
  'in_app',
  'Cobrança gerada',
  'Uma nova cobrança do plano {{plan_name}} foi registrada. Aguardamos a confirmação do pagamento.',
  '{"required":["plan_name"]}'::jsonb
)
ON CONFLICT (template_key, locale, channel) DO NOTHING;
