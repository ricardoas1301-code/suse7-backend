-- ======================================================================
-- Recover: jobs ml_historical_sales_backfill em "running" sem heartbeat.
-- Worker (markStaleRunningJobsAsError): default ML_INITIAL_SYNC_RUNNING_STALE_TIMEOUT_MS = 900000 ms (15 min).
-- Este script usa intervalo '15 minutes' como ponto de partida — alinhe ao seu env se mudou o timeout.
--
-- PASSO 1 — só leitura (confirme linhas stale):
-- ======================================================================

SELECT
  id,
  marketplace_account_id,
  status,
  updated_at,
  now() - updated_at AS age,
  metadata->>'window_index' AS window_index,
  error_message
FROM public.marketplace_account_sync_jobs
WHERE marketplace = 'mercado_livre'
  AND job_type = 'ml_historical_sales_backfill'
  AND status = 'running'
  AND updated_at < (now() - interval '15 minutes')
ORDER BY updated_at ASC;

-- ======================================================================
-- PASSO 2 — após revisar o SELECT acima, descomente o UPDATE transacional.
-- Marca como error para o worker poder re-enfileirar / retomar sem duplicar
-- pedidos (idempotência permanece em marketplace_account_id + external_order_id).
-- ======================================================================

/*
BEGIN;

UPDATE public.marketplace_account_sync_jobs
SET
  status = 'error',
  finished_at = now(),
  updated_at = now(),
  error_message = COALESCE(
    NULLIF(trim(error_message), ''),
    'recovered_stale_running_sql'
  ) || ' | stale_running_recover_sql'
WHERE marketplace = 'mercado_livre'
  AND job_type = 'ml_historical_sales_backfill'
  AND status = 'running'
  AND updated_at < (now() - interval '15 minutes');

COMMIT;
*/
