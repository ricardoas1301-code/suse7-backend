-- =====================================================================
-- S7 — ml_tokens.marketplace_account_id (opcional, enriquecimento)
-- Vincula token à linha marketplace_accounts após OAuth.
-- O callback tenta gravar a coluna e ignora se o schema ainda não tiver.
-- Rode após ml_tokens_multi_account_unique.sql quando quiser o vínculo explícito.
-- =====================================================================

ALTER TABLE public.ml_tokens
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid;

CREATE INDEX IF NOT EXISTS ml_tokens_marketplace_account_id_idx
  ON public.ml_tokens (marketplace_account_id)
  WHERE marketplace_account_id IS NOT NULL;
