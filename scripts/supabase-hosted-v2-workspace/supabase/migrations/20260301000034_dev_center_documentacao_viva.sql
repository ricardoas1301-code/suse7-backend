-- =====================================================================
-- Dev Center — Documentação Viva (Source Of Truth Center)
-- Fase S1_1.10 — Preparar Persistência Supabase.
--
-- Escopo EXCLUSIVO: Documentação Viva do Dev Center.
-- NÃO toca billing, vendas, anúncios, produtos ou marketplace.
--
-- Acesso somente via backend (service role) + allowlist/admin do Dev Center.
-- RLS ativo SEM policies = sem acesso direto pelo PostgREST (JWT do cliente).
--
-- Estrutura preparada para o futuro (S1_1.11):
--   - histórico de versões  (tabela devcenter_doc_item_versions — NÃO criada aqui)
--   - controle por admin    (created_by / updated_by — NÃO obrigatório nesta fase)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Domínios documentais (Página Vendas, Precificações, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_doc_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'em_documentacao', 'em_revisao', 'homologado', 'futuro', 'arquivado')),
  owner text NOT NULL DEFAULT 'Time Suse7',
  maturity text NOT NULL DEFAULT 'mvp'
    CHECK (maturity IN ('mvp', 'beta', 'producao', 'legado')),
  next_review_at date,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ---------------------------------------------------------------------
-- Seções por domínio (Estrutura, Fonte oficial, Regras de cálculo...)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_doc_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL REFERENCES public.devcenter_doc_domains (id) ON DELETE CASCADE,
  section_key text NOT NULL,
  title text NOT NULL,
  hint text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, section_key)
);

-- ---------------------------------------------------------------------
-- Itens por seção (cards operacionais documentais)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_doc_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES public.devcenter_doc_sections (id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'em_documentacao', 'em_revisao', 'homologado', 'futuro', 'arquivado')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Índices úteis
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_devcenter_doc_sections_domain
  ON public.devcenter_doc_sections (domain_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_devcenter_doc_items_section
  ON public.devcenter_doc_items (section_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_devcenter_doc_domains_status
  ON public.devcenter_doc_domains (status);
-- Lista ativa (soft delete): só domínios não removidos
CREATE INDEX IF NOT EXISTS idx_devcenter_doc_domains_active
  ON public.devcenter_doc_domains (sort_order, created_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_devcenter_doc_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_devcenter_doc_domains_touch ON public.devcenter_doc_domains;
CREATE TRIGGER trg_devcenter_doc_domains_touch
  BEFORE UPDATE ON public.devcenter_doc_domains
  FOR EACH ROW EXECUTE PROCEDURE public.touch_devcenter_doc_updated_at();

DROP TRIGGER IF EXISTS trg_devcenter_doc_sections_touch ON public.devcenter_doc_sections;
CREATE TRIGGER trg_devcenter_doc_sections_touch
  BEFORE UPDATE ON public.devcenter_doc_sections
  FOR EACH ROW EXECUTE PROCEDURE public.touch_devcenter_doc_updated_at();

DROP TRIGGER IF EXISTS trg_devcenter_doc_items_touch ON public.devcenter_doc_items;
CREATE TRIGGER trg_devcenter_doc_items_touch
  BEFORE UPDATE ON public.devcenter_doc_items
  FOR EACH ROW EXECUTE PROCEDURE public.touch_devcenter_doc_updated_at();

-- ---------------------------------------------------------------------
-- RLS ativo sem policies = acesso só via service role (backend)
-- ---------------------------------------------------------------------
ALTER TABLE public.devcenter_doc_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devcenter_doc_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devcenter_doc_items ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Documentação
-- ---------------------------------------------------------------------
COMMENT ON TABLE public.devcenter_doc_domains IS 'Documentação Viva — domínios (Source Of Truth). Acesso via backend Dev Center.';
COMMENT ON TABLE public.devcenter_doc_sections IS 'Documentação Viva — seções por domínio.';
COMMENT ON TABLE public.devcenter_doc_items IS 'Documentação Viva — itens (cards operacionais) por seção.';
COMMENT ON COLUMN public.devcenter_doc_domains.deleted_at IS 'Soft delete. NULL = ativo.';
COMMENT ON COLUMN public.devcenter_doc_domains.next_review_at IS 'Próxima revisão documental prevista.';
