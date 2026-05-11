-- ======================================================================
-- Diagnóstico: jobs ML de vendas / histórico (marketplace_account_sync_jobs)
-- Rode no SQL Editor (Supabase) antes de qualquer recover.
-- Ajuste :account_id se quiser filtrar uma conta (ex.: 4896e931-...).
-- ======================================================================

-- Visão geral por status + tipo (últimos 500)
SELECT
  job_type,
  status,
  COUNT(*) AS n
FROM public.marketplace_account_sync_jobs
WHERE marketplace = 'mercado_livre'
  AND job_type IN (
    'ml_initial_sales_recent',
    'ml_initial_sales_history',
    'ml_historical_sales_backfill',
    'ml_sales_enrichment_backfill'
  )
GROUP BY 1, 2
ORDER BY n DESC;

-- Jobs históricos presos em running (heartbeat = updated_at)
SELECT
  id,
  marketplace_account_id,
  user_id,
  status,
  progress_current,
  progress_total,
  error_message,
  created_at,
  updated_at,
  started_at,
  finished_at,
  metadata->>'window_index' AS window_index,
  metadata->>'date_from' AS date_from,
  metadata->>'date_to' AS date_to
FROM public.marketplace_account_sync_jobs
WHERE marketplace = 'mercado_livre'
  AND job_type = 'ml_historical_sales_backfill'
  AND status = 'running'
ORDER BY updated_at ASC
LIMIT 100;

-- Opcional: filtrar uma conta
-- AND marketplace_account_id = '4896e931-1b48-460a-ab3d-a2d97d00b20f'::uuid
