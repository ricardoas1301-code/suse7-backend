-- =============================================================================
-- Fase 3.2.2 — Grupos de destinatário (pessoa) + regras por evento/canal
-- NÃO destrói dados. Compatível com linhas 3.2.1 (1 row por canal).
--
-- Rollback (manual):
--   DROP TABLE public.s7_notification_event_delivery_rules;
--   DROP INDEX IF EXISTS s7_notification_recipients_group_id_idx;
--   ALTER TABLE public.s7_notification_recipients DROP COLUMN IF EXISTS recipient_group_id;
-- =============================================================================

ALTER TABLE public.s7_notification_recipients
  ADD COLUMN IF NOT EXISTS recipient_group_id UUID;

-- Backfill: cada linha órfã vira seu próprio grupo (preserva histórico)
UPDATE public.s7_notification_recipients
SET recipient_group_id = gen_random_uuid()
WHERE recipient_group_id IS NULL;

ALTER TABLE public.s7_notification_recipients
  ALTER COLUMN recipient_group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS s7_notification_recipients_group_id_idx
  ON public.s7_notification_recipients (seller_id, recipient_group_id);

-- Regras: evento × pessoa (group) × canal
CREATE TABLE IF NOT EXISTS public.s7_notification_event_delivery_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL,
  category_code TEXT NOT NULL REFERENCES public.s7_notification_categories (code),
  type_key TEXT NOT NULL,
  recipient_group_id UUID NOT NULL,
  channel TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_event_delivery_rules_channel_chk
    CHECK (channel IN ('email', 'whatsapp')),
  CONSTRAINT s7_notification_event_delivery_rules_uq
    UNIQUE (seller_id, category_code, type_key, recipient_group_id, channel),
  CONSTRAINT s7_notification_event_delivery_rules_type_fk
    FOREIGN KEY (category_code, type_key)
    REFERENCES public.s7_notification_event_types (category_code, type_key)
);

CREATE INDEX IF NOT EXISTS s7_notification_event_delivery_rules_seller_event_idx
  ON public.s7_notification_event_delivery_rules (seller_id, category_code, type_key);

CREATE INDEX IF NOT EXISTS s7_notification_event_delivery_rules_group_idx
  ON public.s7_notification_event_delivery_rules (recipient_group_id);

ALTER TABLE public.s7_notification_event_delivery_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS s7_notification_event_delivery_rules_seller_all ON public.s7_notification_event_delivery_rules;
CREATE POLICY s7_notification_event_delivery_rules_seller_all
  ON public.s7_notification_event_delivery_rules
  FOR ALL
  TO authenticated
  USING (seller_id = auth.uid())
  WITH CHECK (seller_id = auth.uid());
