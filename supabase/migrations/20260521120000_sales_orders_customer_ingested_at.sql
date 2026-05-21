-- =============================================================================
-- Clientes 360 S7 — idempotência de ingestão por pedido (write path A)
-- Sem nova tabela: marcador em sales_orders existente.
-- =============================================================================

ALTER TABLE IF EXISTS public.sales_orders
  ADD COLUMN IF NOT EXISTS customer_ingested_at timestamptz NULL;

COMMENT ON COLUMN public.sales_orders.customer_ingested_at IS
  'Preenchido quando customerIngestionService materializa marketplace_customers a partir deste pedido.';

CREATE INDEX IF NOT EXISTS sales_orders_pending_customer_ingest_idx
  ON public.sales_orders (user_id, marketplace, customer_ingested_at)
  WHERE customer_ingested_at IS NULL;
