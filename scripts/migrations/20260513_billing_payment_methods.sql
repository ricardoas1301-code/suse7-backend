-- billing_payment_methods — cartões tokenizados (sem PAN/CVV)
-- Executar manualmente no Supabase quando aprovado.

CREATE TABLE IF NOT EXISTS public.billing_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  asaas_customer_id text,
  gateway text NOT NULL DEFAULT 'asaas',
  gateway_payment_method_id text,
  provider text NOT NULL DEFAULT 'asaas',
  method_type text NOT NULL DEFAULT 'CREDIT_CARD',
  brand text,
  last4 text,
  holder_name text,
  expiration_month text,
  expiration_year text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE',
  is_default boolean NOT NULL DEFAULT false,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_payment_methods_user_id_idx
  ON public.billing_payment_methods (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_methods_one_default_per_user
  ON public.billing_payment_methods (user_id)
  WHERE is_default = true;

CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_methods_gateway_token_uidx
  ON public.billing_payment_methods (user_id, gateway, gateway_payment_method_id)
  WHERE gateway_payment_method_id IS NOT NULL AND status = 'ACTIVE';

ALTER TABLE public.billing_payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_payment_methods_select_own ON public.billing_payment_methods;
CREATE POLICY billing_payment_methods_select_own
  ON public.billing_payment_methods
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_payment_methods_insert_own ON public.billing_payment_methods;
CREATE POLICY billing_payment_methods_insert_own
  ON public.billing_payment_methods
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_payment_methods_update_own ON public.billing_payment_methods;
CREATE POLICY billing_payment_methods_update_own
  ON public.billing_payment_methods
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_payment_methods_delete_own ON public.billing_payment_methods;
CREATE POLICY billing_payment_methods_delete_own
  ON public.billing_payment_methods
  FOR DELETE
  USING (auth.uid() = user_id);
