-- =============================================================================
-- DASH.5.1 — Dias de operação do seller (ciclo operacional Resumo Diário)
-- Convenção: 0=domingo … 6=sábado (padrão JS). Default = todos os dias (legado).
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS operational_working_days smallint[] NOT NULL
  DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[];

COMMENT ON COLUMN public.profiles.operational_working_days IS
  'Dias em que a operação trabalha (0=dom … 6=sáb). Usado com operational_day_closes_at no ciclo do Resumo Diário.';
