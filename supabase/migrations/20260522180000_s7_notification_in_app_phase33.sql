-- =============================================================================
-- S7 Central Notification Engine — Fase 3.3 In-App Inbox
-- Campos de inbox em s7_notification_dispatches (channel = in_app)
-- =============================================================================

ALTER TABLE public.s7_notification_dispatches
  ADD COLUMN IF NOT EXISTS category_code TEXT,
  ADD COLUMN IF NOT EXISTS type_key TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS message TEXT,
  ADD COLUMN IF NOT EXISTS severity TEXT,
  ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deep_link TEXT;

CREATE INDEX IF NOT EXISTS s7_notification_dispatches_in_app_inbox_idx
  ON public.s7_notification_dispatches (seller_id, created_at DESC)
  WHERE channel = 'in_app';

CREATE INDEX IF NOT EXISTS s7_notification_dispatches_in_app_unread_idx
  ON public.s7_notification_dispatches (seller_id, created_at DESC)
  WHERE channel = 'in_app' AND is_read = FALSE;
