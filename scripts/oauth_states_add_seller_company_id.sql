-- =====================================================================
-- oauth_states.seller_company_id — contexto CNPJ/empresa no OAuth ML
-- Sem esta coluna, o backend não pode persistir "Conectar nova conta"
-- e o callback cairia na empresa errada.
-- Rode no SQL Editor do Supabase (DEV → PROD após validar).
-- =====================================================================

ALTER TABLE public.oauth_states
  ADD COLUMN IF NOT EXISTS seller_company_id uuid;

COMMENT ON COLUMN public.oauth_states.seller_company_id IS
  'Empresa (CNPJ) escolhida no fluxo OAuth ML; obrigatório para contas adicionais.';

CREATE INDEX IF NOT EXISTS oauth_states_state_marketplace_expires_idx
  ON public.oauth_states (state, marketplace, expires_at);
