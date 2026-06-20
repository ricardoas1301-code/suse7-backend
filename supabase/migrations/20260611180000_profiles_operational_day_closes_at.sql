-- =============================================================================
-- DASH.5 — Hora de encerramento operacional do seller (Resumo Diário Dashboard)
-- Default 18:00 para sellers existentes e novos cadastros.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS operational_day_closes_at time NOT NULL DEFAULT '18:00:00';

COMMENT ON COLUMN public.profiles.operational_day_closes_at IS
  'Hora de encerramento operacional do seller; define o ciclo nativo do Resumo Diário no Dashboard.';
