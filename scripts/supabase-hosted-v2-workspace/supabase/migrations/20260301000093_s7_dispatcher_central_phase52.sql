-- =============================================================================
-- S7 — Dispatcher Central (Fase S5.2)
-- Consolida o Dispatcher Central que consome o Contrato Global (S5.1).
-- NÃO cria dispatcher paralelo: apenas ESTENDE s7_notification_dispatches para
-- suportar status por canal mais ricos e preparar retry/fallback.
--
-- Mudanças 100% aditivas (superset de status + colunas nullable):
--   1. status: adiciona PROCESSING, DEDUPED, RETRY_SCHEDULED (mantém os antigos)
--   2. next_retry_at        → quando um retry está agendado
--   3. max_attempts         → teto de tentativas previsto para o dispatch
--   4. fallback_from_dispatch_id → origem quando o dispatch é fallback de outro
--   5. fallback_channel     → canal de origem do fallback (rastreabilidade)
-- =============================================================================

-- 1. Status por canal mais rico (superset — preserva os valores existentes) ----
ALTER TABLE public.s7_notification_dispatches
  DROP CONSTRAINT IF EXISTS s7_notification_dispatches_status_chk;

ALTER TABLE public.s7_notification_dispatches
  ADD CONSTRAINT s7_notification_dispatches_status_chk
  CHECK (status IN (
    'PENDING',
    'PROCESSING',
    'QUEUED',
    'SENT',
    'FAILED',
    'SKIPPED',
    'DEDUPED',
    'RETRY_SCHEDULED'
  ));

-- 2 a 5. Colunas de retry/fallback (nullable / default seguro) -----------------
ALTER TABLE public.s7_notification_dispatches
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE public.s7_notification_dispatches
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 1;

ALTER TABLE public.s7_notification_dispatches
  ADD COLUMN IF NOT EXISTS fallback_from_dispatch_id UUID
    REFERENCES public.s7_notification_dispatches (id) ON DELETE SET NULL;

ALTER TABLE public.s7_notification_dispatches
  ADD COLUMN IF NOT EXISTS fallback_channel TEXT;

COMMENT ON COLUMN public.s7_notification_dispatches.next_retry_at IS
  'Quando um retry deste dispatch está agendado (status RETRY_SCHEDULED). NULL = sem retry pendente.';
COMMENT ON COLUMN public.s7_notification_dispatches.max_attempts IS
  'Teto de tentativas previsto para o dispatch (preparação de retry controlado).';
COMMENT ON COLUMN public.s7_notification_dispatches.fallback_from_dispatch_id IS
  'Dispatch de origem quando este foi criado como fallback de canal de outro dispatch.';
COMMENT ON COLUMN public.s7_notification_dispatches.fallback_channel IS
  'Canal de origem do fallback (rastreabilidade do encadeamento de canais).';

-- Índice de suporte ao varredor de retries agendados.
CREATE INDEX IF NOT EXISTS s7_notification_dispatches_retry_due_idx
  ON public.s7_notification_dispatches (status, next_retry_at)
  WHERE next_retry_at IS NOT NULL;
