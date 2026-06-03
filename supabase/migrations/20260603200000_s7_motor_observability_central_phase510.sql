-- =============================================================================
-- S7 — Observabilidade do Motor Central (Fase S5.10)
-- Formalização documental — reutiliza events, dispatches e delivery_logs.
-- =============================================================================

COMMENT ON TABLE public.s7_notification_events IS
  'Eventos do Motor Central (S5.1). Origem da timeline de observabilidade S5.10.';

COMMENT ON TABLE public.s7_notification_dispatches IS
  'Dispatches por canal/destinatário. Nó central da jornada evento → entrega (S5.10).';

COMMENT ON TABLE public.s7_notification_delivery_logs IS
  'Auditoria por tentativa de entrega — fonte oficial de rastreio S5.10 (reutilizada, sem tabela paralela).';

COMMENT ON TABLE public.s7_notification_email_outbox IS
  'Outbox e-mail — worker /api/internal/notifications/email/process';

COMMENT ON TABLE public.s7_notification_whatsapp_outbox IS
  'Outbox WhatsApp — worker /api/internal/notifications/whatsapp/process';
