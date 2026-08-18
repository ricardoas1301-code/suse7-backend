-- marketplace slug (primeira etapa). Unicidade (user_id, marketplace) e remoção do UNIQUE só em user_id:
-- ver migration 20260325100000_ml_tokens_marketplace_composite_unique.sql
ALTER TABLE public.ml_tokens
  ADD COLUMN IF NOT EXISTS marketplace text NOT NULL DEFAULT 'mercado_livre';

COMMENT ON COLUMN public.ml_tokens.marketplace IS 'Slug do marketplace, ex.: mercado_livre';
