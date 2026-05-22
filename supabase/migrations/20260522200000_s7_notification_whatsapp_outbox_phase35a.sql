-- =============================================================================
-- S7 Central Notification Engine — Fase 3.5A WhatsApp Outbox
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.s7_notification_whatsapp_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  dispatch_id UUID NOT NULL REFERENCES public.s7_notification_dispatches (id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES public.s7_notification_recipients (id) ON DELETE SET NULL,
  recipient_phone TEXT NOT NULL,
  message_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT s7_notification_whatsapp_outbox_status_chk
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  CONSTRAINT s7_notification_whatsapp_outbox_dispatch_uq
    UNIQUE (dispatch_id)
);

CREATE INDEX IF NOT EXISTS s7_notification_whatsapp_outbox_pending_idx
  ON public.s7_notification_whatsapp_outbox (status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS s7_notification_whatsapp_outbox_seller_created_idx
  ON public.s7_notification_whatsapp_outbox (seller_id, created_at DESC);
