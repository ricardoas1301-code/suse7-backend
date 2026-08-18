-- =============================================================================
-- DEV.V2 CORE SCHEMA BOOTSTRAP — fresh replay compat
-- Posição: após baseline + sales bridge, antes migrations backend históricas
--
-- Fecha P0:
--   • plans.id elegível para FK (PK histórica name preservada)
--   • seller_companies foundational CREATE
--   • marketplace_accounts foundational CREATE
--   • marketplace_customers minimal CREATE (20260505183000 assume tabela)
--
-- Forward-safe: IF NOT EXISTS / guards; não altera PK de plans; sem FK user_id→auth
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) PLANS — billing FK compat (20260209120000 exige REFERENCES plans(id))
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.plans') IS NULL THEN
    RAISE EXCEPTION 'core_bootstrap: public.plans ausente — aplicar baseline primeiro';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans' AND column_name = 'id'
  ) THEN
    ALTER TABLE public.plans ADD COLUMN id uuid DEFAULT gen_random_uuid();
  END IF;

  UPDATE public.plans SET id = gen_random_uuid() WHERE id IS NULL;

  IF EXISTS (SELECT 1 FROM public.plans WHERE id IS NULL LIMIT 1) THEN
    RAISE EXCEPTION 'core_bootstrap: plans.id possui NULLs após backfill — resolver antes de NOT NULL';
  END IF;

  -- Só aplica NOT NULL se a coluna ainda permitir null (idempotente em ambientes já endurecidos)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans' AND column_name = 'id' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.plans ALTER COLUMN id SET NOT NULL;
  END IF;

  ALTER TABLE public.plans ALTER COLUMN id SET DEFAULT gen_random_uuid();
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS plans_id_unique_idx ON public.plans (id);

COMMENT ON COLUMN public.plans.id IS 'UUID estável para FKs billing; PK histórica permanece name.';

-- -----------------------------------------------------------------------------
-- 2) SELLER_COMPANIES — foundational (contrato DEV evidenciado; sem FK auth.users)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_name text NOT NULL,
  trade_name text,
  document_cnpj text NOT NULL,
  tax_regime text,
  default_tax_rate numeric,
  operational_cost_rate numeric,
  internal_notes text,
  phone text,
  whatsapp text,
  cep text,
  address_street text,
  address_number text,
  address_complement text,
  address_district text,
  address_city text,
  address_state text,
  logo_url text,
  is_primary boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  contact_email text
);

CREATE UNIQUE INDEX IF NOT EXISTS seller_companies_user_document_uniq
  ON public.seller_companies (user_id, document_cnpj);

CREATE INDEX IF NOT EXISTS seller_companies_user_id_idx
  ON public.seller_companies (user_id);

CREATE INDEX IF NOT EXISTS seller_companies_user_primary_idx
  ON public.seller_companies (user_id)
  WHERE is_primary = true;

ALTER TABLE public.seller_companies ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3) MARKETPLACE_ACCOUNTS — foundational (FK seller_company_id only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  seller_company_id uuid NOT NULL REFERENCES public.seller_companies (id) ON DELETE CASCADE,
  marketplace text NOT NULL DEFAULT 'mercado_livre',
  external_seller_id text NOT NULL,
  account_alias text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scope text,
  token_type text,
  ml_nickname text,
  status text NOT NULL DEFAULT 'active',
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ml_sales_last_sync_at timestamptz,
  ml_sales_last_synced_order_created_to timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_accounts_user_marketplace_seller_uniq
  ON public.marketplace_accounts (user_id, marketplace, external_seller_id);

CREATE INDEX IF NOT EXISTS marketplace_accounts_user_id_idx
  ON public.marketplace_accounts (user_id);

CREATE INDEX IF NOT EXISTS marketplace_accounts_company_id_idx
  ON public.marketplace_accounts (seller_company_id);

CREATE INDEX IF NOT EXISTS marketplace_accounts_marketplace_idx
  ON public.marketplace_accounts (marketplace);

ALTER TABLE public.marketplace_accounts ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 4) MARKETPLACE_CUSTOMERS — minimal (20260505183000 ALTER sem IF EXISTS na tabela)
--    Colunas multiconta chegam via 20260506102000 ADD COLUMN IF NOT EXISTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  marketplace text NOT NULL DEFAULT 'mercado_livre',
  external_customer_id text NOT NULL,
  name text,
  email text,
  phone text,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_customers_user_id_idx
  ON public.marketplace_customers (user_id);

ALTER TABLE public.marketplace_customers ENABLE ROW LEVEL SECURITY;
