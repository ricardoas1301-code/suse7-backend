-- ======================================================================
-- OAuth ML: opcional seller_company_id no state (multiconta / reauth).
-- Idempotente: não quebra inserts legados sem a coluna após deploy.
-- ======================================================================

ALTER TABLE IF EXISTS public.oauth_states
  ADD COLUMN IF NOT EXISTS seller_company_id uuid NULL;

DO $$
BEGIN
  IF to_regclass('public.oauth_states') IS NOT NULL
     AND to_regclass('public.seller_companies') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'oauth_states_seller_company_id_fkey'
     ) THEN
    ALTER TABLE public.oauth_states
      ADD CONSTRAINT oauth_states_seller_company_id_fkey
      FOREIGN KEY (seller_company_id) REFERENCES public.seller_companies (id) ON DELETE SET NULL;
  END IF;
END $$;
