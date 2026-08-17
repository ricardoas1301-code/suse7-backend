-- =============================================================================
-- Fase 3.2.1 — Unicidade destinatário por seller + canal + destino
-- =============================================================================

-- 1) Deduplicar: manter 1 linha por (seller_id, channel, destination)
--    Prioridade: ativo primeiro, depois o mais antigo (created_at ASC)
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY seller_id, channel, destination
      ORDER BY is_active DESC, created_at ASC, id ASC
    ) AS rn
  FROM public.s7_notification_recipients
),
dupes AS (
  SELECT id FROM ranked WHERE rn > 1
)
DELETE FROM public.s7_notification_recipients
WHERE id IN (SELECT id FROM dupes);

-- 2) Índice único oficial
CREATE UNIQUE INDEX IF NOT EXISTS s7_notification_recipients_seller_channel_dest_uq
  ON public.s7_notification_recipients (seller_id, channel, destination);
