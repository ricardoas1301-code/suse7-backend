-- Cobertura técnica da importação de vendas ML por job (Supabase / Postgres).
-- Aplicar manualmente no SQL editor ou via pipeline de migrations do projeto.

CREATE TABLE IF NOT EXISTS marketplace_account_sales_import_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  marketplace text NOT NULL,
  marketplace_account_id uuid NOT NULL,
  seller_company_id uuid,
  external_seller_id text,
  sync_type text NOT NULL,
  status text NOT NULL,
  date_from timestamptz,
  date_to timestamptz,
  api_total integer,
  fetched_total integer,
  saved_total integer,
  duplicate_total integer,
  skipped_total integer,
  error_total integer,
  last_offset integer,
  last_error_code text,
  last_error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  source_job_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_account_sales_import_coverage_source_job_unique UNIQUE (source_job_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_import_coverage_account
  ON marketplace_account_sales_import_coverage (marketplace_account_id, sync_type);

CREATE INDEX IF NOT EXISTS idx_sales_import_coverage_user
  ON marketplace_account_sales_import_coverage (user_id, marketplace);

COMMENT ON TABLE marketplace_account_sales_import_coverage IS
  'Cobertura da importação ML: totais API vs persistidos, offsets e erros por marketplace_account_sync_jobs.id';
