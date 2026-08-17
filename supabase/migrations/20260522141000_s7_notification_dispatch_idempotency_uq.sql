-- =============================================================================
-- Fase 3.1 — idempotência de dispatch por slot (evento × canal × destinatário)
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS s7_notification_dispatches_event_channel_slot_uq
  ON public.s7_notification_dispatches (
    event_id,
    channel,
    COALESCE(recipient_id::text, '__owner__'),
    COALESCE(destination, '')
  );
