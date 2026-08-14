-- =============================================================================
-- CARD.CONFIGURATION.ONBOARDING.01B — evidências históricas (latches) por conta
-- Escopo: public.profiles (USER/account) — ciclo operacional é account-level;
-- primeira integração e conclusão da trilha são marcos da conta autenticada.
-- Sem backfill: defaults operacionais NÃO implicam configured_at.
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS operational_cycle_configured_at timestamptz NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_marketplace_connected_at timestamptz NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS initial_configuration_completed_at timestamptz NULL;

COMMENT ON COLUMN public.profiles.operational_cycle_configured_at IS
  'Evidência de que o seller confirmou ciclo operacional (hora + dias). Defaults técnicos não preenchem este campo.';

COMMENT ON COLUMN public.profiles.first_marketplace_connected_at IS
  'Latch histórico: primeira integração marketplace válida concluída. Não regredir por desconexão posterior.';

COMMENT ON COLUMN public.profiles.initial_configuration_completed_at IS
  'Latch histórico: Configuração Inicial 6/6 concluída. Monotônico; não autoridade do percentual antes da conclusão.';
