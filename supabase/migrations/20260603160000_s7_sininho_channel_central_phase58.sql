-- =============================================================================
-- S7 — Central Sininho (Fase S5.8)
-- Formalização de histórico/arquivamento no inbox in_app (sem regras de negócio).
-- Backend permanece fonte de verdade em s7_notification_dispatches (channel = in_app).
-- =============================================================================

ALTER TABLE public.s7_notification_dispatches
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS s7_notification_dispatches_in_app_event_idx
  ON public.s7_notification_dispatches (event_id, created_at DESC)
  WHERE channel = 'in_app' AND event_id IS NOT NULL;

COMMENT ON COLUMN public.s7_notification_dispatches.archived_at IS
  'Arquivamento do item no inbox Sininho (S5.8). Uso operacional em fase futura; NULL = ativo.';

COMMENT ON TABLE public.s7_notification_dispatches IS
  'Dispatches do Motor Central. channel=in_app: inbox Sininho (título, leitura, deep_link, archived_at).';
