-- =============================================================================
-- Fase S5.13 — Fale Conosco no Motor Central (e-mail oficial)
-- =============================================================================

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
VALUES
  (
    'SYSTEM',
    'FALE_CONOSCO_TEAM',
    'Fale Conosco — equipe',
    'Formulário público: notificação interna para a equipe Suse7',
    'info',
    TRUE,
    '["email"]'::jsonb,
    '["email"]'::jsonb,
    'system.fale_conosco.team',
    TRUE
  ),
  (
    'SYSTEM',
    'FALE_CONOSCO_CONFIRMATION',
    'Fale Conosco — confirmação',
    'Formulário público: confirmação de recebimento ao remetente',
    'info',
    TRUE,
    '["email"]'::jsonb,
    '["email"]'::jsonb,
    'system.fale_conosco.confirmation',
    TRUE
  )
ON CONFLICT (category_code, type_key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  severity_default = EXCLUDED.severity_default,
  is_mandatory = EXCLUDED.is_mandatory,
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
    'system.fale_conosco.team',
    'SYSTEM',
    'FALE_CONOSCO_TEAM',
    'email',
    'pt-BR',
    'high',
    '[Fale Conosco] {{contact_subject}}',
    E'Nova mensagem pelo formulário Fale Conosco:\n\nNome: {{contact_name}}\nE-mail: {{contact_email}}\nAssunto: {{contact_subject}}\n\nMensagem:\n{{contact_message}}'
  ),
  (
    'system.fale_conosco.confirmation',
    'SYSTEM',
    'FALE_CONOSCO_CONFIRMATION',
    'email',
    'pt-BR',
    'normal',
    'Recebemos sua mensagem — Suse7',
    E'Olá {{contact_name}},\n\nRecebemos sua mensagem com o assunto "{{contact_subject}}".\n\nNossa equipe retornará o contato em breve pelo e-mail informado.\n\n— Equipe Suse7'
  )
ON CONFLICT (template_key, channel, locale) DO UPDATE SET
  category_code = EXCLUDED.category_code,
  type_key = EXCLUDED.type_key,
  priority = EXCLUDED.priority,
  subject_template = EXCLUDED.subject_template,
  body_template = EXCLUDED.body_template,
  is_active = TRUE,
  updated_at = NOW();
