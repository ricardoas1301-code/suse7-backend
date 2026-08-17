-- ============================================================
-- S7 Mission Control — Fase 2 — Eventos, entregas e auditoria
-- Requer: notification_contacts, marketplace_accounts
-- ============================================================

CREATE OR REPLACE FUNCTION public.s7_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- notification_events — evento detectado (histórico imutável)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  notification_type text NOT NULL,
  marketplace text NULL,
  marketplace_account_id uuid NULL REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL,
  seller_company_id uuid NULL,
  entity_type text NULL,
  entity_id text NULL,
  title text NOT NULL,
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NULL,
  severity text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_events_severity_chk CHECK (
    severity IS NULL OR severity IN ('critical', 'important', 'medium', 'info')
  )
);

CREATE INDEX IF NOT EXISTS idx_notification_events_user_id
  ON public.notification_events (user_id);

CREATE INDEX IF NOT EXISTS idx_notification_events_notification_type
  ON public.notification_events (notification_type);

CREATE INDEX IF NOT EXISTS idx_notification_events_marketplace_account_id
  ON public.notification_events (marketplace_account_id);

CREATE INDEX IF NOT EXISTS idx_notification_events_created_at_desc
  ON public.notification_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_events_fingerprint
  ON public.notification_events (fingerprint);

CREATE INDEX IF NOT EXISTS idx_notification_events_user_fingerprint_created
  ON public.notification_events (user_id, fingerprint, created_at DESC);

COMMENT ON TABLE public.notification_events IS 'Fase 2 — eventos detectados; dedupe por fingerprint + janela na aplicação.';

-- Vincular sininho legado ao motor (coluna opcional)
ALTER TABLE IF EXISTS public.notifications
  ADD COLUMN IF NOT EXISTS notification_event_id uuid NULL;

DO $$
BEGIN
  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_notification_event_id_fkey;
  ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_notification_event_id_fkey
    FOREIGN KEY (notification_event_id) REFERENCES public.notification_events(id) ON DELETE SET NULL;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
END $$;

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_notifications_notification_event_id
    ON public.notifications(notification_event_id);
EXCEPTION
  WHEN undefined_table THEN NULL;
END $$;

-- ------------------------------------------------------------
-- notification_deliveries — uma linha por destino/canal
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_event_id uuid NOT NULL REFERENCES public.notification_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  contact_id uuid NULL REFERENCES public.notification_contacts(id) ON DELETE SET NULL,
  notification_channel text NOT NULL,
  destination text NULL,
  provider text NULL,
  provider_message_id text NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NULL,
  next_retry_at timestamptz NULL,
  sent_at timestamptz NULL,
  delivered_at timestamptz NULL,
  failed_at timestamptz NULL,
  error_message text NULL,
  provider_response jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_channel_chk CHECK (notification_channel IN ('app', 'email', 'whatsapp')),
  CONSTRAINT notification_deliveries_status_chk CHECK (
    status IN ('pending', 'processing', 'sent', 'delivered', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status
  ON public.notification_deliveries (status);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_next_retry_at
  ON public.notification_deliveries (next_retry_at);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created_at
  ON public.notification_deliveries (created_at);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user_id
  ON public.notification_deliveries (user_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification_channel
  ON public.notification_deliveries (notification_channel);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification_event_id
  ON public.notification_deliveries (notification_event_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_worker_pending
  ON public.notification_deliveries (created_at ASC)
  WHERE status = 'pending';

-- Evita duplicar linhas ao re-enfileirar o mesmo evento/canal/destino
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_uniq_app_owner
  ON public.notification_deliveries (notification_event_id)
  WHERE notification_channel = 'app' AND contact_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_uniq_contact_channel
  ON public.notification_deliveries (notification_event_id, notification_channel, contact_id)
  WHERE contact_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_notification_deliveries_updated ON public.notification_deliveries;
CREATE TRIGGER trg_notification_deliveries_updated
  BEFORE UPDATE ON public.notification_deliveries
  FOR EACH ROW
  EXECUTE PROCEDURE public.s7_touch_updated_at();

COMMENT ON TABLE public.notification_deliveries IS 'Fase 2 — fila de entrega (workers processam pending).';

-- ------------------------------------------------------------
-- notification_delivery_logs — auditoria
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_delivery_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_delivery_id uuid NOT NULL REFERENCES public.notification_deliveries(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_logs_delivery_id
  ON public.notification_delivery_logs (notification_delivery_id);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_logs_created_at
  ON public.notification_delivery_logs (created_at DESC);

COMMENT ON TABLE public.notification_delivery_logs IS 'Fase 2 — logs por tentativa (retry/provider).';
