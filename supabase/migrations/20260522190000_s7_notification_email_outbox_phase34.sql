-- =============================================================================
-- S7 Central Notification Engine — Fase 3.4 Email Outbox
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.s7_notification_email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  dispatch_id UUID NOT NULL REFERENCES public.s7_notification_dispatches (id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES public.s7_notification_recipients (id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_message_id TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT s7_notification_email_outbox_status_chk
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  CONSTRAINT s7_notification_email_outbox_dispatch_uq
    UNIQUE (dispatch_id)
);

CREATE INDEX IF NOT EXISTS s7_notification_email_outbox_pending_idx
  ON public.s7_notification_email_outbox (status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS s7_notification_email_outbox_seller_created_idx
  ON public.s7_notification_email_outbox (seller_id, created_at DESC);
