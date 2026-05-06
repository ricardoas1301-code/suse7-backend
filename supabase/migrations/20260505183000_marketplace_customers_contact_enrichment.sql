-- =============================================================================
-- Clientes 360 S7 — campos de contato enriquecidos (ML oficial / LGPD-aware)
-- =============================================================================

ALTER TABLE public.marketplace_customers
  ADD COLUMN IF NOT EXISTS email_is_masked boolean NOT NULL DEFAULT false;

ALTER TABLE public.marketplace_customers
  ADD COLUMN IF NOT EXISTS phone_area_code text NULL;

ALTER TABLE public.marketplace_customers
  ADD COLUMN IF NOT EXISTS phone_number text NULL;

ALTER TABLE public.marketplace_customers
  ADD COLUMN IF NOT EXISTS whatsapp_e164 text NULL;

ALTER TABLE public.marketplace_customers
  ADD COLUMN IF NOT EXISTS contact_source text NULL;

ALTER TABLE public.marketplace_customers
  ADD COLUMN IF NOT EXISTS contact_updated_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS marketplace_customers_whatsapp_e164_idx
  ON public.marketplace_customers (whatsapp_e164);

-- email / phone já possuem índices na migration inicial; garantir índice em whatsapp
