-- ======================================================================
-- Jobs de onboarding / sync por conta marketplace (multi-marketplace).
-- Histórico inicial ML + etapas futuras (anúncios, produtos, clientes, webhook).
-- ======================================================================

CREATE TABLE IF NOT EXISTS public.marketplace_account_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL DEFAULT 'mercado_livre',
  marketplace_account_id uuid REFERENCES public.marketplace_accounts (id) ON DELETE CASCADE,
  seller_company_id uuid REFERENCES public.seller_companies (id) ON DELETE SET NULL,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  progress_current integer NOT NULL DEFAULT 0,
  progress_total integer,
  started_at timestamptz,
  finished_at timestamptz,
  last_cursor text,
  last_synced_at timestamptz,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketplace_account_sync_jobs IS
  'Fila assíncrona de sincronização por conta (OAuth ML → histórico + etapas). Worker: POST /api/jobs/marketplace-account-sync';

COMMENT ON COLUMN public.marketplace_account_sync_jobs.job_type IS
  'Ex.: ml_initial_sales_history | ml_initial_listings | ml_initial_products | ml_initial_customers | ml_enable_webhook_monitoring';

COMMENT ON COLUMN public.marketplace_account_sync_jobs.status IS
  'pending | running | done | error';

COMMENT ON COLUMN public.marketplace_account_sync_jobs.last_cursor IS
  'Cursor opaco (JSON serializado) para retomar paginação entre invocações serverless.';

CREATE INDEX IF NOT EXISTS marketplace_account_sync_jobs_account_idx
  ON public.marketplace_account_sync_jobs (marketplace_account_id);

CREATE INDEX IF NOT EXISTS marketplace_account_sync_jobs_status_created_idx
  ON public.marketplace_account_sync_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS marketplace_account_sync_jobs_user_idx
  ON public.marketplace_account_sync_jobs (user_id);

CREATE INDEX IF NOT EXISTS marketplace_account_sync_jobs_pending_account_idx
  ON public.marketplace_account_sync_jobs (marketplace_account_id, created_at)
  WHERE status = 'pending';
