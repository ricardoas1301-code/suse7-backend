-- =============================================================================
-- ML webhook events: rastreio de erro para evitar loop silencioso de pending.
-- =============================================================================

ALTER TABLE IF EXISTS public.ml_webhook_events
  ADD COLUMN IF NOT EXISTS seller_company_id uuid NULL,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_message text;

COMMENT ON COLUMN public.ml_webhook_events.last_error_code IS
  'Último código de erro de processamento do evento webhook.';

COMMENT ON COLUMN public.ml_webhook_events.last_error_message IS
  'Última mensagem de erro de processamento do evento webhook.';

COMMENT ON COLUMN public.ml_webhook_events.seller_company_id IS
  'Seller company resolvida para o evento no momento do processamento.';

