-- =============================================================================
-- ML webhook events — timestamps de fila/processamento para observabilidade
-- =============================================================================

ALTER TABLE IF EXISTS public.ml_webhook_events
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN public.ml_webhook_events.started_at IS
  'Primeira vez que o evento entrou em processamento (job ml-webhook-events).';

COMMENT ON COLUMN public.ml_webhook_events.completed_at IS
  'Conclusão do processamento (done, ignored ou error terminal).';

COMMENT ON COLUMN public.ml_webhook_events.heartbeat_at IS
  'Último heartbeat do worker enquanto status=processing.';

CREATE INDEX IF NOT EXISTS ml_webhook_events_processing_heartbeat_idx
  ON public.ml_webhook_events (status, heartbeat_at)
  WHERE status = 'processing';
