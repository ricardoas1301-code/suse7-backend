-- S7 — índice único exigido pelo upsert PostgREST:
--   onConflict: "user_id,marketplace,ml_user_id"
--
-- Rode no Supabase SQL Editor após revisar índices legados:
-- se existir UNIQUE (user_id, marketplace) sem ml_user_id, o segundo seller ML
-- não consegue gravar token — ajuste ou remova o índice antigo antes.

CREATE UNIQUE INDEX IF NOT EXISTS ml_tokens_user_marketplace_ml_user_uidx
  ON public.ml_tokens (user_id, marketplace, ml_user_id);

COMMENT ON INDEX public.ml_tokens_user_marketplace_ml_user_uidx IS
  'Suse7 ML multi-conta: upsert ml_tokens por (user_id, marketplace, ml_user_id).';
