-- =============================================================================
-- DEV.V2.ML-OAUTH-ONBOARDING-M6-IMPLEMENTATION.01E-C
-- Unicidade global race-safe: mesma conta ML (external_seller_id) ativa no ecossistema.
-- Registros removed permanecem históricos e NÃO entram no índice.
-- Aplicar SOMENTE após precheck read-only (scripts/precheck_marketplace_global_unique.mjs).
-- Target Fresh DEV: alkelcaoexxbamqddaqv
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_accounts_global_active_external_uidx
  ON public.marketplace_accounts (marketplace, external_seller_id)
  WHERE status IS DISTINCT FROM 'removed';

COMMENT ON INDEX public.marketplace_accounts_global_active_external_uidx IS
  '01E-C: impede duas empresas SUSE7 ativas com a mesma conta ML (external_seller_id). Soft-delete (removed) excluído.';
