-- billing_payment_methods — tipo de cartão e flag de recorrência automática
-- Executar após 20260513_billing_payment_methods.sql

ALTER TABLE public.billing_payment_methods
  ADD COLUMN IF NOT EXISTS card_type text NOT NULL DEFAULT 'CREDIT',
  ADD COLUMN IF NOT EXISTS supports_auto_renew boolean NOT NULL DEFAULT false;

UPDATE public.billing_payment_methods
SET
  card_type = CASE
    WHEN upper(coalesce(method_type, '')) LIKE '%DEBIT%' THEN 'DEBIT'
    ELSE 'CREDIT'
  END,
  supports_auto_renew = CASE
    WHEN upper(coalesce(method_type, '')) LIKE '%DEBIT%' THEN false
    ELSE true
  END
WHERE card_type IS NULL OR supports_auto_renew IS NULL;

ALTER TABLE public.billing_payment_methods
  DROP CONSTRAINT IF EXISTS billing_payment_methods_card_type_check;

ALTER TABLE public.billing_payment_methods
  ADD CONSTRAINT billing_payment_methods_card_type_check
  CHECK (card_type IN ('CREDIT', 'DEBIT'));

CREATE INDEX IF NOT EXISTS billing_payment_methods_card_type_idx
  ON public.billing_payment_methods (user_id, card_type)
  WHERE status = 'ACTIVE';
