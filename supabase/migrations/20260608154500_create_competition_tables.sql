-- ======================================================================
-- S7 — S1 Modelagem do Banco de Concorrência (Concorrência Inteligente)
-- Tabelas: competition_competitors (seleção viva) + competition_snapshots (histórico imutável)
-- Base: docs/competition/mercado-livre-discovery.md (§5 dados mínimos, §7 modelagem)
-- Multi-marketplace, multi-conta e multi-CNPJ. Valores monetários em numeric (nunca float).
-- Apenas modelagem: sem handler, sem endpoint, sem chamadas ao Mercado Livre.
-- ======================================================================

-- ----------------------------------------------------------------------
-- Função genérica de updated_at (idempotente; já existe no projeto — reuso)
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.s7_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ======================================================================
-- 1) competition_competitors — concorrentes ativos/monitorados pelo seller
--    (entidade "viva": o seller escolhe quem acompanhar; sincroniza com o MKP)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.competition_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  marketplace text NOT NULL,
  -- conta/empresa preservam histórico → ON DELETE SET NULL (não CASCADE)
  marketplace_account_id uuid NULL REFERENCES public.marketplace_accounts (id) ON DELETE SET NULL,
  seller_company_id uuid NULL REFERENCES public.seller_companies (id) ON DELETE SET NULL,
  -- entidade principal é produto/SKU; se o produto some, a seleção dele some junto
  product_id uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  sku text NULL,
  competitor_listing_id text NOT NULL,
  competitor_title text NULL,
  competitor_seller_id text NULL,
  competitor_store_name text NULL,
  competitor_permalink text NULL,
  competitor_thumbnail text NULL,
  source_strategy text NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_seen_price numeric(14,2) NULL,
  last_seen_currency text NULL DEFAULT 'BRL',
  last_captured_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.competition_competitors IS
  'Concorrentes ativos/monitorados pelo seller, por produto/SKU. Seleção viva (sincroniza com o marketplace). Limite de 9 ativos por (user_id, marketplace, product_id).';
COMMENT ON COLUMN public.competition_competitors.source_strategy IS
  'Estratégia que descobriu o concorrente: ml_catalog | ml_search (+versão do heurístico).';
COMMENT ON COLUMN public.competition_competitors.is_active IS
  'true = monitorado. Remoção do seller é soft-delete (is_active = false), preservando histórico de snapshots.';
COMMENT ON COLUMN public.competition_competitors.last_seen_price IS
  'Último preço observado (numeric 14,2). Snapshot temporal fica em competition_snapshots.';

-- Unicidade: 1 concorrente ativo por (user, marketplace, produto, anúncio concorrente)
CREATE UNIQUE INDEX IF NOT EXISTS competition_competitors_active_uidx
  ON public.competition_competitors (
    user_id,
    marketplace,
    product_id,
    competitor_listing_id
  )
  WHERE is_active = true;

-- Índices de performance
CREATE INDEX IF NOT EXISTS competition_competitors_user_product_active_idx
  ON public.competition_competitors (user_id, product_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS competition_competitors_account_idx
  ON public.competition_competitors (marketplace_account_id);

CREATE INDEX IF NOT EXISTS competition_competitors_company_idx
  ON public.competition_competitors (seller_company_id);

CREATE INDEX IF NOT EXISTS competition_competitors_listing_idx
  ON public.competition_competitors (competitor_listing_id);

CREATE INDEX IF NOT EXISTS competition_competitors_marketplace_product_idx
  ON public.competition_competitors (marketplace, product_id);

-- updated_at automático (apenas na tabela de seleção viva)
DROP TRIGGER IF EXISTS trg_competition_competitors_updated ON public.competition_competitors;
CREATE TRIGGER trg_competition_competitors_updated
  BEFORE UPDATE ON public.competition_competitors
  FOR EACH ROW
  EXECUTE PROCEDURE public.s7_touch_updated_at();

-- ======================================================================
-- 2) competition_snapshots — histórico IMUTÁVEL das capturas dos concorrentes
--    (sem updated_at, sem update trigger, sem unique por preço/data)
-- ======================================================================
CREATE TABLE IF NOT EXISTS public.competition_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- soft-delete do concorrente preserva snapshots; purge real do registro leva o histórico junto
  competitor_id uuid NOT NULL REFERENCES public.competition_competitors (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  marketplace_account_id uuid NULL REFERENCES public.marketplace_accounts (id) ON DELETE SET NULL,
  seller_company_id uuid NULL REFERENCES public.seller_companies (id) ON DELETE SET NULL,
  product_id uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  sku text NULL,
  competitor_listing_id text NOT NULL,
  competitor_title text NULL,
  competitor_price numeric(14,2) NULL,
  currency text NULL DEFAULT 'BRL',
  competitor_seller_id text NULL,
  competitor_store_name text NULL,
  competitor_permalink text NULL,
  competitor_thumbnail text NULL,
  shipping jsonb NULL,
  listing_type text NULL,
  reputation jsonb NULL,
  sales_hint integer NULL,
  source_strategy text NULL,
  raw_snapshot jsonb NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.competition_snapshots IS
  'Histórico imutável das capturas de concorrentes (preço, frete, reputação, oferta). Suse7 é a fonte de memória histórica. Sem updated_at e sem update — append-only.';
COMMENT ON COLUMN public.competition_snapshots.sales_hint IS
  'Pista de vendas (sold_quantity do ML), estimada/agregada — não usar como número financeiro.';
COMMENT ON COLUMN public.competition_snapshots.raw_snapshot IS
  'Payload bruto do marketplace no momento da captura (auditoria/retrocompatibilidade).';

-- Índices de série temporal
CREATE INDEX IF NOT EXISTS competition_snapshots_competitor_captured_idx
  ON public.competition_snapshots (competitor_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS competition_snapshots_product_captured_idx
  ON public.competition_snapshots (product_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS competition_snapshots_user_captured_idx
  ON public.competition_snapshots (user_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS competition_snapshots_account_captured_idx
  ON public.competition_snapshots (marketplace_account_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS competition_snapshots_company_captured_idx
  ON public.competition_snapshots (seller_company_id, captured_at DESC);

-- ======================================================================
-- 3) Limite de até 9 concorrentes ATIVOS por (user_id, marketplace, product_id)
--    Trigger BEFORE INSERT/UPDATE: só conta is_active = true; ignora o próprio registro.
--    Permite atualizar um ativo existente e permite desativar sem bloquear.
-- ======================================================================
CREATE OR REPLACE FUNCTION public.s7_competition_enforce_active_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
BEGIN
  -- Só validamos quando o registro resultante está/ficará ativo.
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO active_count
  FROM public.competition_competitors c
  WHERE c.user_id = NEW.user_id
    AND c.marketplace = NEW.marketplace
    AND c.product_id = NEW.product_id
    AND c.is_active = true
    AND c.id <> NEW.id;

  IF active_count >= 9 THEN
    RAISE EXCEPTION 'Limite de 9 concorrentes ativos por produto atingido.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_competition_competitors_active_limit ON public.competition_competitors;
CREATE TRIGGER trg_competition_competitors_active_limit
  BEFORE INSERT OR UPDATE ON public.competition_competitors
  FOR EACH ROW
  EXECUTE PROCEDURE public.s7_competition_enforce_active_limit();

-- ======================================================================
-- 4) RLS — isolamento por usuário (auth.uid() = user_id)
--    Handlers de escrita usam service role (bypassa RLS) com filtro user_id,
--    como já ocorre nas demais tabelas do projeto.
-- ======================================================================
ALTER TABLE public.competition_competitors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competition_competitors_select_own ON public.competition_competitors;
CREATE POLICY competition_competitors_select_own ON public.competition_competitors
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_competitors_insert_own ON public.competition_competitors;
CREATE POLICY competition_competitors_insert_own ON public.competition_competitors
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_competitors_update_own ON public.competition_competitors;
CREATE POLICY competition_competitors_update_own ON public.competition_competitors
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_competitors_delete_own ON public.competition_competitors;
CREATE POLICY competition_competitors_delete_own ON public.competition_competitors
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Snapshots: imutáveis para o usuário comum — apenas SELECT e INSERT.
-- Sem policy de UPDATE/DELETE → negados por padrão com RLS habilitada.
ALTER TABLE public.competition_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competition_snapshots_select_own ON public.competition_snapshots;
CREATE POLICY competition_snapshots_select_own ON public.competition_snapshots
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_snapshots_insert_own ON public.competition_snapshots;
CREATE POLICY competition_snapshots_insert_own ON public.competition_snapshots
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
