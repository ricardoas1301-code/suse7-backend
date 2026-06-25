-- ============================================================
-- S7 Mission Control — Fase 1 — Destinatários e regras de roteamento
-- Tabelas: notification_contacts, notification_routing_rules
-- ============================================================

-- ------------------------------------------------------------
-- Função genérica updated_at (idempotente)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.s7_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- notification_contacts — contatos operacionais (sem login)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  role text NULL,
  whatsapp text NULL,
  email text NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_contacts_user_id
  ON public.notification_contacts (user_id);

CREATE INDEX IF NOT EXISTS idx_notification_contacts_user_active
  ON public.notification_contacts (user_id, active);

DROP TRIGGER IF EXISTS trg_notification_contacts_updated ON public.notification_contacts;
CREATE TRIGGER trg_notification_contacts_updated
  BEFORE UPDATE ON public.notification_contacts
  FOR EACH ROW
  EXECUTE PROCEDURE public.s7_touch_updated_at();

COMMENT ON TABLE public.notification_contacts IS 'Destinatários operacionais de notificação (sem usuário de sistema).';

-- ------------------------------------------------------------
-- notification_routing_rules — tipo × canal × contato × conta marketplace
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  notification_type text NOT NULL,
  notification_channel text NOT NULL,
  contact_id uuid NULL REFERENCES public.notification_contacts(id) ON DELETE CASCADE,
  marketplace_account_id uuid NULL REFERENCES public.marketplace_accounts(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_routing_rules_channel_chk
    CHECK (notification_channel IN ('app', 'email', 'whatsapp'))
);

CREATE INDEX IF NOT EXISTS idx_notification_routing_rules_lookup
  ON public.notification_routing_rules (
    user_id,
    notification_type,
    notification_channel,
    marketplace_account_id
  );

CREATE INDEX IF NOT EXISTS idx_notification_routing_rules_contact
  ON public.notification_routing_rules (contact_id)
  WHERE contact_id IS NOT NULL;

-- Evita duplicidade de regras ativas equivalentes (NULL tratado com sentinela UUID dedicada)
CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_rules_active_dedupe
  ON public.notification_routing_rules (
    user_id,
    notification_type,
    notification_channel,
    COALESCE(contact_id, '00000000-0000-0000-0000-000000000001'::uuid),
    COALESCE(marketplace_account_id, '00000000-0000-0000-0000-000000000002'::uuid)
  )
  WHERE active = true;

DROP TRIGGER IF EXISTS trg_notification_routing_rules_updated ON public.notification_routing_rules;
CREATE TRIGGER trg_notification_routing_rules_updated
  BEFORE UPDATE ON public.notification_routing_rules
  FOR EACH ROW
  EXECUTE PROCEDURE public.s7_touch_updated_at();

COMMENT ON TABLE public.notification_routing_rules IS 'Roteamento configurável: tipo de alerta, canal, destinatário e conta marketplace.';
