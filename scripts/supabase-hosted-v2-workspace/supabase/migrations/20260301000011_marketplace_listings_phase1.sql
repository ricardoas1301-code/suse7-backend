-- ======================================================================
-- FASE 1 — Anúncios multi-marketplace (Mercado Livre primeiro)
-- Tabelas: listing principal + descrição, atributos, fotos, variações,
-- frete e snapshots brutos (auditoria / replay).
-- ======================================================================

-- ----------------------------------------------------------------------
-- 1) marketplace_listings
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_listing_id text NOT NULL,
  site_id text,
  title text,
  subtitle text,
  category_id text,
  domain_id text,
  listing_type_id text,
  status text,
  permalink text,
  price numeric(18, 6),
  base_price numeric(18, 6),
  original_price numeric(18, 6),
  currency_id text,
  available_quantity integer,
  sold_quantity integer,
  buying_mode text,
  condition text,
  seller_sku text,
  catalog_listing boolean,
  catalog_product_id text,
  health numeric(5, 2),
  date_created timestamptz,
  last_updated timestamptz,
  api_imported_at timestamptz NOT NULL DEFAULT now(),
  api_last_seen_at timestamptz NOT NULL DEFAULT now(),
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_listings_marketplace_external_unique UNIQUE (marketplace, external_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_user_mkt
  ON public.marketplace_listings (user_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status
  ON public.marketplace_listings (status);

COMMENT ON TABLE public.marketplace_listings IS 'Anúncios importados de marketplaces (multi-tenant via user_id).';

-- ----------------------------------------------------------------------
-- 2) marketplace_listing_descriptions
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listing_descriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  plain_text text,
  html_text text,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_listing_descriptions_listing_unique UNIQUE (listing_id)
);

-- ----------------------------------------------------------------------
-- 3) marketplace_listing_attributes
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listing_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  attribute_id text,
  name text,
  value_id text,
  value_name text,
  value_struct jsonb,
  values_json jsonb,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mla_listing_id ON public.marketplace_listing_attributes (listing_id);

-- ----------------------------------------------------------------------
-- 4) marketplace_listing_pictures
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listing_pictures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  external_picture_id text,
  url text,
  secure_url text,
  position integer,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mlp_listing_id ON public.marketplace_listing_pictures (listing_id);

-- ----------------------------------------------------------------------
-- 5) marketplace_listing_variations
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listing_variations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  external_variation_id text NOT NULL,
  price numeric(18, 6),
  available_quantity integer,
  sold_quantity integer,
  attribute_combinations jsonb,
  picture_ids jsonb,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_listing_variations_listing_ext_unique UNIQUE (listing_id, external_variation_id)
);

-- ----------------------------------------------------------------------
-- 6) marketplace_listing_shipping
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listing_shipping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  mode text,
  free_shipping boolean,
  logistic_type text,
  local_pick_up boolean,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_listing_shipping_listing_unique UNIQUE (listing_id)
);

-- ----------------------------------------------------------------------
-- 7) marketplace_listing_raw_snapshots
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketplace_listing_raw_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mlrs_listing_created ON public.marketplace_listing_raw_snapshots (listing_id, created_at DESC);

-- ----------------------------------------------------------------------
-- RLS (leitura pelo próprio usuário; backend usa service_role — ignora RLS)
-- ----------------------------------------------------------------------
ALTER TABLE public.marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_listing_descriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_listing_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_listing_pictures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_listing_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_listing_shipping ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_listing_raw_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_listings_select_own ON public.marketplace_listings;
CREATE POLICY marketplace_listings_select_own ON public.marketplace_listings
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS marketplace_listing_descriptions_select_own ON public.marketplace_listing_descriptions;
CREATE POLICY marketplace_listing_descriptions_select_own ON public.marketplace_listing_descriptions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_listing_descriptions.listing_id AND ml.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS marketplace_listing_attributes_select_own ON public.marketplace_listing_attributes;
CREATE POLICY marketplace_listing_attributes_select_own ON public.marketplace_listing_attributes
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_listing_attributes.listing_id AND ml.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS marketplace_listing_pictures_select_own ON public.marketplace_listing_pictures;
CREATE POLICY marketplace_listing_pictures_select_own ON public.marketplace_listing_pictures
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_listing_pictures.listing_id AND ml.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS marketplace_listing_variations_select_own ON public.marketplace_listing_variations;
CREATE POLICY marketplace_listing_variations_select_own ON public.marketplace_listing_variations
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_listing_variations.listing_id AND ml.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS marketplace_listing_shipping_select_own ON public.marketplace_listing_shipping;
CREATE POLICY marketplace_listing_shipping_select_own ON public.marketplace_listing_shipping
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_listing_shipping.listing_id AND ml.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS marketplace_listing_raw_snapshots_select_own ON public.marketplace_listing_raw_snapshots;
CREATE POLICY marketplace_listing_raw_snapshots_select_own ON public.marketplace_listing_raw_snapshots
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_listing_raw_snapshots.listing_id AND ml.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------
-- Grants (Supabase: service_role para backend; authenticated leitura opcional)
-- ----------------------------------------------------------------------
GRANT SELECT ON public.marketplace_listings TO authenticated;
GRANT SELECT ON public.marketplace_listing_descriptions TO authenticated;
GRANT SELECT ON public.marketplace_listing_attributes TO authenticated;
GRANT SELECT ON public.marketplace_listing_pictures TO authenticated;
GRANT SELECT ON public.marketplace_listing_variations TO authenticated;
GRANT SELECT ON public.marketplace_listing_shipping TO authenticated;
GRANT SELECT ON public.marketplace_listing_raw_snapshots TO authenticated;

GRANT ALL ON public.marketplace_listings TO service_role;
GRANT ALL ON public.marketplace_listing_descriptions TO service_role;
GRANT ALL ON public.marketplace_listing_attributes TO service_role;
GRANT ALL ON public.marketplace_listing_pictures TO service_role;
GRANT ALL ON public.marketplace_listing_variations TO service_role;
GRANT ALL ON public.marketplace_listing_shipping TO service_role;
GRANT ALL ON public.marketplace_listing_raw_snapshots TO service_role;
