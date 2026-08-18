-- ======================================================================
-- Saúde / performance por anúncio (multi-marketplace; 1 linha por user+mkt+listing)
-- Fonte principal: GET /items/:id + opcional visits + performance (ML).
-- Não duplica marketplace_listings; métricas operacionais e raw_json enriquecido.
-- ======================================================================

CREATE TABLE IF NOT EXISTS public.marketplace_listing_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  external_listing_id text NOT NULL,
  visits integer,
  orders_count integer,
  conversion_rate numeric(18, 6),
  sale_fee_percent numeric(18, 6),
  sale_fee_amount numeric(18, 6),
  shipping_cost numeric(18, 6),
  net_receivable numeric(18, 6),
  promotion_price numeric(18, 6),
  listing_quality_score numeric(18, 6),
  listing_quality_status text,
  listing_quality_substatus text,
  experience_status text,
  experience_substatus text,
  shipping_mode text,
  shipping_logistic_type text,
  shipping_tags jsonb,
  marketplace_messages jsonb,
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_imported_at timestamptz NOT NULL DEFAULT now(),
  api_last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_listing_health_user_mkt_listing_unique UNIQUE (user_id, marketplace, external_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_health_user_mkt
  ON public.marketplace_listing_health (user_id, marketplace);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_health_external_listing
  ON public.marketplace_listing_health (external_listing_id);

COMMENT ON TABLE public.marketplace_listing_health IS 'Métricas de visitas, taxas, frete, qualidade e experiência por anúncio importado.';
COMMENT ON COLUMN public.marketplace_listing_health.orders_count IS 'Reservado; contagem distinta de pedidos vem de listing_sales_metrics. Preenchido quando API ML expuser equivalente.';
COMMENT ON COLUMN public.marketplace_listing_health.visits IS 'Visitas (resource /visits ou /items/visits quando disponível).';

ALTER TABLE public.marketplace_listing_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_listing_health_select_own ON public.marketplace_listing_health;
CREATE POLICY marketplace_listing_health_select_own ON public.marketplace_listing_health
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON public.marketplace_listing_health TO authenticated;
GRANT ALL ON public.marketplace_listing_health TO service_role;
