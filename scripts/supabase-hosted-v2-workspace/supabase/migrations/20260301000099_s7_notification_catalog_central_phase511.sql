-- =============================================================================
-- S7 — Catálogo de Notificações (Fase S5.11)
-- Formalização documental — reutiliza categories + event_types existentes.
-- Tabela futura de definições do catálogo NÃO criada nesta fase (esqueleto em código).
-- =============================================================================

COMMENT ON TABLE public.s7_notification_categories IS
  'Categorias oficiais do Catálogo de Notificações (S5.11). Fonte para category_code em eventos e preferências.';

COMMENT ON TABLE public.s7_notification_event_types IS
  'Tipos de evento por categoria (S5.11). Futuro cadastro em massa de notificações referenciará esta tabela.';

COMMENT ON COLUMN public.s7_notification_event_types.is_mandatory IS
  'Obrigatoriedade no catálogo — integra preferências S5.9 e dispatcher.';

COMMENT ON COLUMN public.s7_notification_event_types.severity_default IS
  'Prioridade/severity padrão: info, warning, critical (catálogo S5.11 também reconhece high via contrato).';

COMMENT ON COLUMN public.s7_notification_event_types.supported_channels IS
  'Canais permitidos (JSON) — alinhado ao Registro Oficial de Canais S5.3.';
