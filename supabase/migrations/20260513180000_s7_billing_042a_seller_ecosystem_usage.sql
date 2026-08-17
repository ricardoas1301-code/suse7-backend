-- BILLING 04.2.A — consolidação seller-centric (ecossistema operacional)

ALTER TABLE public.billing_monthly_usage
  ADD COLUMN IF NOT EXISTS aggregation_scope text NOT NULL DEFAULT 'seller_ecosystem';

ALTER TABLE public.billing_usage_snapshots
  ADD COLUMN IF NOT EXISTS aggregation_scope text NOT NULL DEFAULT 'seller_ecosystem',
  ADD COLUMN IF NOT EXISTS breakdowns jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.billing_usage_events
  ADD COLUMN IF NOT EXISTS aggregation_scope text NOT NULL DEFAULT 'seller_ecosystem';

COMMENT ON COLUMN public.billing_monthly_usage.aggregation_scope IS
  'Escopo da agregação principal. seller_ecosystem = todas as empresas, contas e marketplaces do seller.';

COMMENT ON COLUMN public.billing_usage_snapshots.breakdowns IS
  'Breakdowns analíticos (marketplace/conta/empresa). Não definem plano nem cobrança.';
