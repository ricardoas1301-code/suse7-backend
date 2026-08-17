-- =============================================================================
-- ML webhook events: guard de schema para ambientes DEV desatualizados.
-- Garante colunas usadas no insert/processamento do webhook.
-- =============================================================================

ALTER TABLE IF EXISTS public.ml_webhook_events
  ADD COLUMN IF NOT EXISTS marketplace text NOT NULL DEFAULT 'mercado_livre',
  ADD COLUMN IF NOT EXISTS topic text,
  ADD COLUMN IF NOT EXISTS resource text,
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS marketplace_user_id text,
  ADD COLUMN IF NOT EXISTS application_id text,
  ADD COLUMN IF NOT EXISTS external_event_id text,
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_ip text,
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF to_regclass('public.ml_webhook_events') IS NOT NULL
     AND to_regclass('public.marketplace_accounts') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'ml_webhook_events_marketplace_account_id_fkey'
     ) THEN
    ALTER TABLE public.ml_webhook_events
      ADD CONSTRAINT ml_webhook_events_marketplace_account_id_fkey
      FOREIGN KEY (marketplace_account_id) REFERENCES public.marketplace_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ml_webhook_events_dedupe_uidx
  ON public.ml_webhook_events (dedupe_key);

CREATE INDEX IF NOT EXISTS ml_webhook_events_status_created_idx
  ON public.ml_webhook_events (status, created_at);

CREATE INDEX IF NOT EXISTS ml_webhook_events_marketplace_account_idx
  ON public.ml_webhook_events (marketplace_account_id);

