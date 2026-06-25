-- Fase 3 — limite de retries manuais por delivery
ALTER TABLE IF EXISTS public.notification_deliveries
  ADD COLUMN IF NOT EXISTS manual_retry_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.notification_deliveries.manual_retry_count IS 'Fase 3 — tentativas de reprocessamento solicitadas pelo usuário (teto na API).';
