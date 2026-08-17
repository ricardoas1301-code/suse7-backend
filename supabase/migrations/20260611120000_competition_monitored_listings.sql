-- ======================================================================
-- S7 — Concorrência: anúncios monitorados (âncora operacional da lista)
-- Migra o conceito SKU → concorrentes para ANÚNCIO MONITORADO → concorrentes.
-- Sem migração automática de dados legados nesta fase.
-- ======================================================================

-- ----------------------------------------------------------------------
-- 1) competition_monitored_listings — seleção explícita do seller
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.competition_monitored_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  marketplace text NOT NULL DEFAULT 'mercado_livre',
  marketplace_account_id uuid NULL REFERENCES public.marketplace_accounts (id) ON DELETE SET NULL,
  seller_company_id uuid NULL REFERENCES public.seller_companies (id) ON DELETE SET NULL,
  marketplace_listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  external_listing_id text NOT NULL,
  product_id uuid NULL REFERENCES public.products (id) ON DELETE SET NULL,
  sku text NULL,
  product_name text NULL,
  listing_title text NULL,
  is_monitored boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.competition_monitored_listings IS
  'Anúncios escolhidos pelo seller para monitoramento na Página Concorrência. Cada linha da lista representa um registro ativo aqui.';

CREATE UNIQUE INDEX IF NOT EXISTS competition_monitored_listings_active_uidx
  ON public.competition_monitored_listings (user_id, marketplace, external_listing_id)
  WHERE is_monitored = true;

CREATE INDEX IF NOT EXISTS competition_monitored_listings_user_active_idx
  ON public.competition_monitored_listings (user_id)
  WHERE is_monitored = true;

CREATE INDEX IF NOT EXISTS competition_monitored_listings_listing_idx
  ON public.competition_monitored_listings (marketplace_listing_id);

DROP TRIGGER IF EXISTS trg_competition_monitored_listings_updated ON public.competition_monitored_listings;
CREATE TRIGGER trg_competition_monitored_listings_updated
  BEFORE UPDATE ON public.competition_monitored_listings
  FOR EACH ROW
  EXECUTE PROCEDURE public.s7_touch_updated_at();

-- ----------------------------------------------------------------------
-- 2) Vínculo concorrente → anúncio monitorado
-- ----------------------------------------------------------------------
ALTER TABLE public.competition_competitors
  ADD COLUMN IF NOT EXISTS monitored_listing_id uuid NULL
  REFERENCES public.competition_monitored_listings (id) ON DELETE CASCADE;

ALTER TABLE public.competition_snapshots
  ADD COLUMN IF NOT EXISTS monitored_listing_id uuid NULL
  REFERENCES public.competition_monitored_listings (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.competition_competitors.monitored_listing_id IS
  'Âncora do anúncio próprio monitorado. Quando preenchido, limite e unicidade são por anúncio, não por SKU.';

-- Unicidade ativa por anúncio monitorado (novo modelo)
CREATE UNIQUE INDEX IF NOT EXISTS competition_competitors_monitored_active_uidx
  ON public.competition_competitors (
    user_id,
    marketplace,
    monitored_listing_id,
    competitor_listing_id
  )
  WHERE is_active = true AND monitored_listing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS competition_competitors_monitored_listing_active_idx
  ON public.competition_competitors (monitored_listing_id)
  WHERE is_active = true;

-- ----------------------------------------------------------------------
-- 3) Limite de concorrentes ativos — por anúncio monitorado quando houver vínculo
-- ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.s7_competition_enforce_active_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_count integer;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.monitored_listing_id IS NOT NULL THEN
    SELECT count(*) INTO active_count
    FROM public.competition_competitors c
    WHERE c.user_id = NEW.user_id
      AND c.marketplace = NEW.marketplace
      AND c.monitored_listing_id = NEW.monitored_listing_id
      AND c.is_active = true
      AND c.id <> NEW.id;

    IF active_count >= 9 THEN
      RAISE EXCEPTION 'Limite de 9 concorrentes ativos por anúncio monitorado atingido.'
        USING ERRCODE = 'check_violation';
    END IF;

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

-- ----------------------------------------------------------------------
-- 4) RLS — isolamento por usuário
-- ----------------------------------------------------------------------
ALTER TABLE public.competition_monitored_listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competition_monitored_listings_select_own ON public.competition_monitored_listings;
CREATE POLICY competition_monitored_listings_select_own ON public.competition_monitored_listings
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_monitored_listings_insert_own ON public.competition_monitored_listings;
CREATE POLICY competition_monitored_listings_insert_own ON public.competition_monitored_listings
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_monitored_listings_update_own ON public.competition_monitored_listings;
CREATE POLICY competition_monitored_listings_update_own ON public.competition_monitored_listings
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS competition_monitored_listings_delete_own ON public.competition_monitored_listings;
CREATE POLICY competition_monitored_listings_delete_own ON public.competition_monitored_listings
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
