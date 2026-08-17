-- ======================================================================
-- Dev Center admin flag + visão global de clientes (dedupe cross-seller)
--
-- Idempotente: banco limpo OU tabela public.s7_global_customers parcial
-- (ex.: sem dedupe_key) — evita ERROR 42703 ao criar índices.
--
-- Diagnóstico: supabase/diagnostics/s7_global_customers_schema.sql
-- RLS: sem policies → PostgREST/anon não leem; service role ignora RLS.
-- ======================================================================

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.is_admin IS 'Dev Center / operações internas — conceder com cautela.';

-- Base: instalação nova. Tabela legada parcial é corrigida nos ALTER seguintes.
CREATE TABLE IF NOT EXISTS public.s7_global_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NULL,
  document_normalized text NULL,
  email_normalized text NULL,
  phone_normalized text NULL,
  name text NULL,
  total_orders_global integer NOT NULL DEFAULT 0,
  total_spent_global numeric(18, 2) NOT NULL DEFAULT 0,
  total_sellers_related integer NOT NULL DEFAULT 0,
  first_purchase_global timestamptz NULL,
  last_purchase_global timestamptz NULL,
  related_sellers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Garantir colunas (migration parcial / schema antigo)
ALTER TABLE public.s7_global_customers
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS document_normalized text,
  ADD COLUMN IF NOT EXISTS email_normalized text,
  ADD COLUMN IF NOT EXISTS phone_normalized text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS total_orders_global integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_spent_global numeric(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_sellers_related integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_purchase_global timestamptz,
  ADD COLUMN IF NOT EXISTS last_purchase_global timestamptz,
  ADD COLUMN IF NOT EXISTS related_sellers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill dedupe_key (alinhado ao app: doc: / email: / phone: / legacy:id)
UPDATE public.s7_global_customers
SET dedupe_key = COALESCE(
  CASE
    WHEN nullif(trim(document_normalized), '') IS NOT NULL THEN 'doc:' || trim(document_normalized)
  END,
  CASE
    WHEN nullif(trim(email_normalized), '') IS NOT NULL THEN 'email:' || lower(trim(email_normalized))
  END,
  CASE
    WHEN nullif(trim(phone_normalized), '') IS NOT NULL THEN 'phone:' || trim(phone_normalized)
  END,
  'legacy:' || id::text
)
WHERE dedupe_key IS NULL
   OR trim(dedupe_key) = '';

ALTER TABLE public.s7_global_customers
  ALTER COLUMN dedupe_key SET NOT NULL;

-- CHECK comprimento (recria se já existir com outra definição)
ALTER TABLE public.s7_global_customers DROP CONSTRAINT IF EXISTS s7_global_customers_dedupe_key_len;

ALTER TABLE public.s7_global_customers
  ADD CONSTRAINT s7_global_customers_dedupe_key_len CHECK (char_length(dedupe_key) <= 512);

-- Índices só depois de dedupe_key garantida
CREATE UNIQUE INDEX IF NOT EXISTS s7_global_customers_dedupe_key_uq
  ON public.s7_global_customers (dedupe_key);

CREATE INDEX IF NOT EXISTS s7_global_customers_doc_idx
  ON public.s7_global_customers (document_normalized)
  WHERE document_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS s7_global_customers_email_idx
  ON public.s7_global_customers (email_normalized)
  WHERE email_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS s7_global_customers_phone_idx
  ON public.s7_global_customers (phone_normalized)
  WHERE phone_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS s7_global_customers_last_purchase_idx
  ON public.s7_global_customers (last_purchase_global DESC NULLS LAST);

COMMENT ON TABLE public.s7_global_customers IS 'Agregado global de compradores (dedupe documento > email > telefone > id ML). Atualizado pelo customerIngestionService.';

ALTER TABLE public.s7_global_customers ENABLE ROW LEVEL SECURITY;
