-- =============================================================================
-- S7 — Preferências de Comunicação (Fase S5.9)
-- Formalização documental — reutiliza tabelas Phase 3.1/3.2 (sem nova fonte de verdade).
-- =============================================================================

COMMENT ON TABLE public.s7_notification_preferences IS
  'Preferências oficiais do Motor Central (S5.9): seller × categoria × tipo × canal. Única fonte para habilitação de canais no Dispatcher.';

COMMENT ON TABLE public.s7_notification_recipients IS
  'Destinatários oficiais (e-mail/WhatsApp) do Motor Central. Sininho usa seller_id; grupos via recipient_group_id.';

COMMENT ON TABLE public.s7_notification_recipient_scopes IS
  'Escopo categoria/tipo por destinatário quando não há regras por evento.';

COMMENT ON TABLE public.s7_notification_event_delivery_rules IS
  'Regras por evento × grupo de destinatário × canal (Central de Notificações).';

COMMENT ON COLUMN public.s7_notification_recipients.is_primary IS
  'Destinatário principal do canal para o seller (S5.9 — governança formal).';
