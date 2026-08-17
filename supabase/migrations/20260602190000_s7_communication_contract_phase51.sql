-- =============================================================================
-- S7 — Contrato Global de Comunicação (Fase S5.1)
-- Formaliza e ESTENDE o motor central existente (s7_notification_events) como o
-- contrato único oficial de comunicação do Suse7. NÃO cria motor paralelo.
--
-- Mudanças 100% aditivas (IF NOT EXISTS + DEFAULT) — preservam o que já funciona:
--   1. contract_version       → versionamento do contrato (evolução sem quebra)
--   2. metadata               → camada de metadata padronizada e extensível
--   3. dedupe_key             → chave de deduplicação por janela
--   4. dedupe_window_seconds  → janela (segundos) considerada para o dedupe
--
-- Diferença entre os dois mecanismos de proteção:
--   - idempotency_key  → replay exato (mesmo evento publicado 2x). JÁ EXISTE.
--   - dedupe_key       → conteúdo equivalente em curto intervalo (janela). NOVO.
-- =============================================================================

-- 1. Versionamento do contrato ------------------------------------------------
ALTER TABLE public.s7_notification_events
  ADD COLUMN IF NOT EXISTS contract_version INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.s7_notification_events.contract_version IS
  'Versão do Contrato Global de Comunicação que gerou este evento. Permite evoluir o envelope sem quebrar eventos antigos.';

-- 2. Metadata padronizada e extensível ----------------------------------------
ALTER TABLE public.s7_notification_events
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.s7_notification_events.metadata IS
  'Envelope de metadata padronizado e extensível (origem técnica, prioridade, trace, snapshot de tenant, contexto). Separado de payload (dados de negócio).';

-- 3 + 4. Deduplicação por janela ----------------------------------------------
ALTER TABLE public.s7_notification_events
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

ALTER TABLE public.s7_notification_events
  ADD COLUMN IF NOT EXISTS dedupe_window_seconds INT;

COMMENT ON COLUMN public.s7_notification_events.dedupe_key IS
  'Impressão de conteúdo lógico para deduplicação por janela (evita publicações idênticas em curto intervalo). NULL = sem dedupe por janela.';

COMMENT ON COLUMN public.s7_notification_events.dedupe_window_seconds IS
  'Janela (em segundos) considerada para o dedupe_key. NULL/0 = dedupe por janela desativado neste evento.';

-- Índice de suporte ao lookup de dedupe por janela (parcial: só quando há chave).
CREATE INDEX IF NOT EXISTS s7_notification_events_dedupe_window_idx
  ON public.s7_notification_events (seller_id, dedupe_key, created_at DESC)
  WHERE dedupe_key IS NOT NULL;
