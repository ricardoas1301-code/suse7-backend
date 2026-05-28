-- S1 Bloco 2 — auditoria operacional da Toolbox Dev Center

CREATE TABLE IF NOT EXISTS public.dev_center_toolbox_operational_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL,
  subscription_id uuid NULL,
  operator_user_id uuid NOT NULL,
  operator_email text NULL,
  operation_type text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dev_center_toolbox_operational_audit_seller_idx
  ON public.dev_center_toolbox_operational_audit (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS dev_center_toolbox_operational_audit_operation_idx
  ON public.dev_center_toolbox_operational_audit (operation_type, created_at DESC);

COMMENT ON TABLE public.dev_center_toolbox_operational_audit IS
  'Auditoria administrativa de operações da Seller Toolbox (Dev Center).';
