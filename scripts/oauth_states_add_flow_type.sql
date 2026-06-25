-- S7 — coluna opcional oauth_states.flow_type (first_account | additional_account)
-- Usada pelo callback para proibir fallback na empresa principal em multi-conta ML.

ALTER TABLE public.oauth_states
  ADD COLUMN IF NOT EXISTS flow_type text;

COMMENT ON COLUMN public.oauth_states.flow_type IS
  'first_account | additional_account — definido em /api/ml/connect conforme contagem de marketplace_accounts ML.';
