-- =============================================================================
-- S7 — Canal Pop-up (Fase S5.7)
-- Infraestrutura de persistência e rastreabilidade (sem eventos de negócio).
-- Backend como fonte de verdade para histórico de exibição/leitura/fechamento.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.s7_notification_popup_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  event_id UUID,
  dispatch_id UUID,
  display_type TEXT NOT NULL DEFAULT 'info',
  display_mode TEXT NOT NULL DEFAULT 'immediate',
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  template_key TEXT,
  locale TEXT NOT NULL DEFAULT 'pt-BR',
  persist_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  displayed_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_popup_deliveries_display_type_chk
    CHECK (display_type IN ('info', 'success', 'warning', 'critical')),
  CONSTRAINT s7_notification_popup_deliveries_display_mode_chk
    CHECK (display_mode IN ('immediate', 'on_demand')),
  CONSTRAINT s7_notification_popup_deliveries_status_chk
    CHECK (status IN ('pending', 'queued', 'displayed', 'read', 'dismissed', 'expired', 'cancelled')),
  CONSTRAINT s7_notification_popup_deliveries_priority_chk
    CHECK (priority IN ('low', 'normal', 'high', 'critical'))
);

CREATE INDEX IF NOT EXISTS s7_notification_popup_deliveries_seller_status_idx
  ON public.s7_notification_popup_deliveries (seller_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS s7_notification_popup_deliveries_event_idx
  ON public.s7_notification_popup_deliveries (event_id, created_at DESC)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS s7_notification_popup_deliveries_dispatch_idx
  ON public.s7_notification_popup_deliveries (dispatch_id)
  WHERE dispatch_id IS NOT NULL;

COMMENT ON TABLE public.s7_notification_popup_deliveries IS
  'Entregas do canal Pop-up (Motor Central S5.7): histórico, status, leitura e fechamento. Sem regras de negócio nesta fase.';
