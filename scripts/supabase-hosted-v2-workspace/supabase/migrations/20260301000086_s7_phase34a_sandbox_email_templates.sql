-- Fase 3.4.A — templates e-mail sandbox (DEV) para revisão visual Rico
INSERT INTO public.s7_notification_templates (
  template_key, category_code, type_key, channel, locale, priority, subject_template, body_template
)
VALUES
  ('billing.payment.generated', 'BILLING', 'PAYMENT_GENERATED', 'email', 'pt-BR', 'normal',
   'Cobrança gerada — {{plan_name}}',
   'Registramos uma nova cobrança do plano {{plan_name}}. Acompanhe o status no painel.'),
  ('billing.renewal.completed', 'BILLING', 'RENEWAL_COMPLETED', 'email', 'pt-BR', 'normal',
   'Renovação próxima — {{plan_name}}',
   'A renovação do plano {{plan_name}} está se aproximando. Revise seus dados de pagamento.'),
  ('profit.negative.margin', 'PROFIT', 'NEGATIVE_MARGIN', 'email', 'pt-BR', 'high',
   'Venda com prejuízo — {{product_name}}',
   'Identificamos uma venda com margem negativa no item {{product_name}}. Vale revisar preço e custos.'),
  ('inventory.low.stock', 'INVENTORY', 'LOW_STOCK', 'email', 'pt-BR', 'normal',
   'Margem ou estoque em atenção — {{product_name}}',
   'O item {{product_name}} está com indicadores de margem ou estoque que merecem atenção.'),
  ('marketplace.price.changed', 'MARKETPLACE', 'PRICE_CHANGED', 'email', 'pt-BR', 'normal',
   'Aumento de frete — {{marketplace_name}}',
   'Detectamos alteração de frete no marketplace {{marketplace_name}}. Confira o impacto nos seus anúncios.'),
  ('marketplace.fee.changed', 'MARKETPLACE', 'FEE_CHANGED', 'email', 'pt-BR', 'normal',
   'Alteração de taxa — {{marketplace_name}}',
   'Houve alteração de taxa no {{marketplace_name}}. Revise a rentabilidade dos anúncios afetados.'),
  ('account.marketplace.disconnected', 'ACCOUNT_HEALTH', 'MARKETPLACE_DISCONNECTED', 'email', 'pt-BR', 'critical',
   'Saúde crítica da conta — {{marketplace_name}}',
   'A integração com {{marketplace_name}} precisa de atenção imediata. Reconecte para evitar interrupções.'),
  ('sync.failed', 'SYNC', 'SYNC_FAILED', 'email', 'pt-BR', 'high',
   'Sincronização falhou',
   'Uma sincronização de dados não foi concluída. Abra o Suse7 para tentar novamente.'),
  ('system.alert', 'SYSTEM', 'SYSTEM_ALERT', 'email', 'pt-BR', 'normal',
   'Alerta operacional Suse7',
   '{{alert_message}}')
ON CONFLICT (template_key, channel, locale) DO UPDATE SET
  subject_template = EXCLUDED.subject_template,
  body_template = EXCLUDED.body_template,
  is_active = TRUE,
  updated_at = NOW();
