-- =============================================================================
-- Mercado Livre webhook events queue (ingestão rápida + processamento assíncrono)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ml_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace text NOT NULL DEFAULT 'mercado_livre',
  topic text,
  resource text,
  user_id text,
  marketplace_user_id text,
  application_id text,
  external_event_id text,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ip text,
  marketplace_account_id uuid NULL REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  error_message text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ml_webhook_events_dedupe_uidx
  ON public.ml_webhook_events (dedupe_key);

CREATE INDEX IF NOT EXISTS ml_webhook_events_status_created_idx
  ON public.ml_webhook_events (status, created_at);

CREATE INDEX IF NOT EXISTS ml_webhook_events_marketplace_account_idx
  ON public.ml_webhook_events (marketplace_account_id);

