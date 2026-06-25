-- Fase 3.0.4 — índices adicionais (performance / consistency scans)

CREATE INDEX IF NOT EXISTS billing_notification_dispatches_user_created_idx
  ON public.billing_notification_dispatches (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_payments_user_created_idx
  ON public.billing_payments (user_id, created_at DESC)
  WHERE provider = 'asaas';
