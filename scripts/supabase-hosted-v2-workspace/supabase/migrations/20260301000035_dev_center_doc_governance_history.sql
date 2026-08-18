-- =====================================================================
-- Dev Center — Documentação Viva: Governança + Histórico
-- Fase S1_1.11A — Histórico e Governança Documental.
--
-- Escopo EXCLUSIVO: Documentação Viva do Dev Center.
-- NÃO toca billing, vendas, anúncios, produtos ou marketplace.
--
-- Acesso somente via backend (service role) + allowlist/admin do Dev Center.
-- RLS ativo SEM policies = sem acesso direto pelo PostgREST (JWT do cliente).
--
-- Esta migration:
--   1. Adiciona campos de homologação/operador em devcenter_doc_domains.
--   2. Cria devcenter_doc_history (trilha before/after por operação).
--
-- Preparada para crescimento futuro (multi-admin / auditoria) sem
-- implementar diff visual nem auditoria administrativa ainda.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Governança documental nos domínios (homologação + último operador)
-- ---------------------------------------------------------------------
ALTER TABLE public.devcenter_doc_domains
  ADD COLUMN IF NOT EXISTS homologated_at timestamptz,
  ADD COLUMN IF NOT EXISTS homologated_by text,
  ADD COLUMN IF NOT EXISTS last_operator text;

COMMENT ON COLUMN public.devcenter_doc_domains.homologated_at IS 'Data/hora da última homologação do domínio.';
COMMENT ON COLUMN public.devcenter_doc_domains.homologated_by IS 'Operador responsável pela última homologação.';
COMMENT ON COLUMN public.devcenter_doc_domains.last_operator IS 'Último operador que alterou o domínio (preparado para multi-admin).';

-- ---------------------------------------------------------------------
-- 2) Trilha histórica (before/after) — domínios, seções e itens
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_doc_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid REFERENCES public.devcenter_doc_domains (id) ON DELETE CASCADE,
  section_id uuid,
  item_id uuid,
  operation_type text NOT NULL,
  label text NOT NULL DEFAULT '',
  before_data jsonb,
  after_data jsonb,
  operator_name text NOT NULL DEFAULT 'Sistema',
  operator_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Timeline por domínio (mais recente primeiro) e leitura global.
CREATE INDEX IF NOT EXISTS idx_devcenter_doc_history_domain
  ON public.devcenter_doc_history (domain_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_devcenter_doc_history_created
  ON public.devcenter_doc_history (created_at DESC);

-- RLS ativo sem policies = acesso só via service role (backend).
ALTER TABLE public.devcenter_doc_history ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.devcenter_doc_history IS 'Documentação Viva — trilha histórica (before/after) de domínios, seções e itens. Acesso via backend Dev Center.';
COMMENT ON COLUMN public.devcenter_doc_history.operation_type IS 'Tipo da operação: domain_created, domain_updated, owner_changed, status_changed, homologated, governance_reopened, section_updated, item_updated.';
COMMENT ON COLUMN public.devcenter_doc_history.before_data IS 'Snapshot simples do estado anterior (sem diff visual nesta fase).';
COMMENT ON COLUMN public.devcenter_doc_history.after_data IS 'Snapshot simples do estado novo.';
COMMENT ON COLUMN public.devcenter_doc_history.operator_id IS 'Operador (auth.users.id) — preparado para multi-admin/auditoria.';
