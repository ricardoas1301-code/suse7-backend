-- =====================================================================
-- Dev Center — Estrutura Administrativa Global + Gestão de Planos
-- Fases S1_2 (Estrutura Administrativa Global) e S1_3 (Gestão de Planos).
--
-- Escopo: gestão administrativa do catálogo de planos (public.plans) e
-- auditoria administrativa global. NÃO altera billing/assinatura do seller,
-- não cria checkout e não mexe em consumo mensal.
--
-- Acesso somente via backend (service role) + allowlist/admin do Dev Center.
--
-- Esta migration é ADITIVA e idempotente:
--   1. Campos administrativos no catálogo de planos (status + descrição comercial).
--   2. Tabela de auditoria administrativa global (best-effort).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Catálogo de planos — campos administrativos (não-billing)
--    admin_status: status comercial/administrativo do plano (catálogo).
--    description : descrição comercial editável sem alterar código.
--    Billing continua usando is_active / billing_required (não tocados aqui).
-- ---------------------------------------------------------------------
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS admin_status text,
  ADD COLUMN IF NOT EXISTS description text;

-- Restringe valores do status administrativo (coluna nova começa NULL → seguro).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plans_admin_status_check'
  ) THEN
    ALTER TABLE public.plans
      ADD CONSTRAINT plans_admin_status_check
      CHECK (admin_status IS NULL OR admin_status IN ('ativo', 'inativo', 'futuro', 'interno'));
  END IF;
END $$;

COMMENT ON COLUMN public.plans.admin_status IS 'Status administrativo do plano (ativo/inativo/futuro/interno). Catálogo Dev Center. NULL = derivar de is_active/billing_required.';
COMMENT ON COLUMN public.plans.description IS 'Descrição comercial do plano (editável pela Gestão Administrativa de Planos).';

-- ---------------------------------------------------------------------
-- 2) Auditoria administrativa global (preparada para multi-admin)
--    Registra before/after por campo alterado. Best-effort: a ausência
--    desta tabela NÃO bloqueia operações administrativas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,
  entity_id text,
  field text,
  before_data jsonb,
  after_data jsonb,
  operator_name text NOT NULL DEFAULT 'Sistema',
  operator_id uuid,
  origin text NOT NULL DEFAULT 'dev_center_admin',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devcenter_admin_audit_entity
  ON public.devcenter_admin_audit (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devcenter_admin_audit_created
  ON public.devcenter_admin_audit (created_at DESC);

-- RLS ativo sem policies = acesso só via service role (backend).
ALTER TABLE public.devcenter_admin_audit ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.devcenter_admin_audit IS 'Auditoria administrativa global do Dev Center (before/after por campo). Acesso via backend.';
COMMENT ON COLUMN public.devcenter_admin_audit.entity IS 'Entidade alterada (ex.: plan).';
COMMENT ON COLUMN public.devcenter_admin_audit.origin IS 'Origem da operação (ex.: dev_center_admin_plans).';
COMMENT ON COLUMN public.devcenter_admin_audit.operator_id IS 'Operador (auth.users.id) — preparado para multi-admin.';
