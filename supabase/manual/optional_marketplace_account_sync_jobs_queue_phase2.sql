-- ======================================================================
-- Espelho de ../../sql/marketplace_account_sync_jobs_queue_phase2.sql
-- Rodar no SQL Editor apenas se for adotar priority/locks na fila ML.
-- ======================================================================

ALTER TABLE marketplace_account_sync_jobs
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

CREATE INDEX IF NOT EXISTS idx_marketplace_sync_jobs_queue_poll
  ON marketplace_account_sync_jobs (marketplace, status, priority DESC, created_at ASC)
  WHERE status IN ('pending', 'running');

-- ----------------------------------------------------------------------
-- Monitoramento sugerido (executar no SQL Editor Supabase)
-- ----------------------------------------------------------------------
--
-- Visão geral da fila Mercado Livre:
--
-- SELECT marketplace,
--        status,
--        job_type,
--        COUNT(*) AS qtd,
--        MIN(created_at) AS oldest_created,
--        MAX(updated_at) AS last_touch
-- FROM marketplace_account_sync_jobs
-- WHERE marketplace = 'mercado_livre'
-- GROUP BY 1, 2, 3
-- ORDER BY marketplace, status, job_type;
--
-- Jobs presos ou candidatos a retry (ajuste intervalos):
--
-- SELECT id,
--        marketplace_account_id,
--        seller_company_id,
--        job_type,
--        status,
--        priority,
--        attempt_count,
--        max_attempts,
--        locked_at,
--        locked_until,
--        locked_by,
--        progress_current,
--        progress_total,
--        error_message,
--        metadata,
--        created_at,
--        updated_at,
--        started_at,
--        finished_at
-- FROM marketplace_account_sync_jobs
-- WHERE marketplace = 'mercado_livre'
--   AND (
--     status = 'pending'
--     OR (status = 'running' AND updated_at < NOW() - INTERVAL '20 minutes')
--     OR (status = 'error' AND attempt_count < max_attempts)
--   )
-- ORDER BY priority DESC, created_at ASC
-- LIMIT 200;
--
-- Idade máxima de pending (segundos desde created_at):
--
-- SELECT job_type,
--        priority,
--        COUNT(*) AS qtd,
--        EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::bigint AS oldest_pending_age_sec
-- FROM marketplace_account_sync_jobs
-- WHERE marketplace = 'mercado_livre'
--   AND status = 'pending'
-- GROUP BY 1, 2
-- ORDER BY MIN(created_at) ASC;
--
-- Quantidade por prioridade:
--
-- SELECT priority, status, COUNT(*) AS qtd
-- FROM marketplace_account_sync_jobs
-- WHERE marketplace = 'mercado_livre'
-- GROUP BY 1, 2
-- ORDER BY priority DESC, status;
--
-- Contas com backfill histórico ativo (running/pending):
--
-- SELECT marketplace_account_id,
--        COUNT(*) FILTER (WHERE status IN ('pending', 'running')) AS jobs_open,
--        MIN(created_at) AS oldest_job
-- FROM marketplace_account_sync_jobs
-- WHERE marketplace = 'mercado_livre'
--   AND job_type = 'ml_historical_sales_backfill'
-- GROUP BY 1
-- HAVING COUNT(*) FILTER (WHERE status IN ('pending', 'running')) > 0
-- ORDER BY oldest_job ASC;
--
-- Throughput aproximado (progress_delta / tempo — requer dois snapshots ou logs).
-- Sugestão produção: métrica em Datadog/observabilidade com contador `ml_orders_persisted`
-- por conta e taxa 429 no cliente HTTP (não usar apenas SQL).
--
-- Retries / 429: instrumentar no worker (logs estruturados) ou tabela de audit.
