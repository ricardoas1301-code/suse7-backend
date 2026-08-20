-- ======================================================================
-- P0.2 — unicidade semântica de janela histórica ML (DEV)
-- Identidade: marketplace_account_id + window_index + date_from + date_to
-- Partial: somente job_type = ml_historical_sales_backfill
-- Rollback: DROP INDEX IF EXISTS public.marketplace_account_sync_jobs_hist_window_sem_uq;
-- ======================================================================

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_account_sync_jobs_hist_window_sem_uq
  ON public.marketplace_account_sync_jobs (
    marketplace_account_id,
    (metadata->>'window_index'),
    (metadata->>'date_from'),
    (metadata->>'date_to')
  )
  WHERE job_type = 'ml_historical_sales_backfill';

COMMENT ON INDEX public.marketplace_account_sync_jobs_hist_window_sem_uq IS
  'P0.2: impede duas janelas semanticamente iguais por conta (race reconcile). Partial ml_historical_sales_backfill.';
