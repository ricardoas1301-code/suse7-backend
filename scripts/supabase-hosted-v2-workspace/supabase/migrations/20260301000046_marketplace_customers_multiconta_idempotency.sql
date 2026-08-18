-- =============================================================================
-- Clientes 360 S7 — idempotência multiconta por conta marketplace
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'marketplace_customers'
      AND column_name = 'marketplace'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'marketplace_customers'
      AND column_name = 'marketplace_account_id'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'marketplace_customers'
      AND column_name = 'external_customer_id'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS marketplace_customers_mkt_acc_external_uidx
      ON public.marketplace_customers (marketplace, marketplace_account_id, external_customer_id)
      WHERE marketplace_account_id IS NOT NULL
        AND external_customer_id IS NOT NULL;
  END IF;
END $$;

