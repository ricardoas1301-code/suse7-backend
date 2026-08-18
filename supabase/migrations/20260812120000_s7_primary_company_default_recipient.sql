-- =============================================================================
-- Destinatário padrão da empresa principal — unicidade estrutural por seller/canal
-- Reutiliza is_primary (já existente) + seller_company_id + metadata.recipient_kind
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS s7_notification_recipients_one_primary_per_seller_channel
  ON public.s7_notification_recipients (seller_id, channel)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS s7_notification_recipients_primary_company_idx
  ON public.s7_notification_recipients (seller_id, seller_company_id)
  WHERE is_primary = true;
