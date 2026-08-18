-- S1 Bloco 3 — marketplace_account_id na auditoria operacional da Toolbox

ALTER TABLE public.dev_center_toolbox_operational_audit
  ADD COLUMN IF NOT EXISTS marketplace_account_id uuid NULL;

CREATE INDEX IF NOT EXISTS dev_center_toolbox_operational_audit_account_idx
  ON public.dev_center_toolbox_operational_audit (marketplace_account_id, created_at DESC)
  WHERE marketplace_account_id IS NOT NULL;
