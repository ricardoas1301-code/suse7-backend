-- ======================================================================
-- S1 — Configuração de sincronização de imagens produto → anúncio
-- Executar manualmente no Supabase (SQL Editor) quando homologar S1.
-- ======================================================================

CREATE TABLE IF NOT EXISTS public.listing_image_sync_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.marketplace_listings (id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  image_link_ids uuid[] NOT NULL DEFAULT '{}',
  marketplace_picture_ids text[] NOT NULL DEFAULT '{}',
  last_synced_at timestamptz,
  last_sync_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_image_sync_settings_listing_unique UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS listing_image_sync_settings_product_idx
  ON public.listing_image_sync_settings (user_id, product_id);

CREATE INDEX IF NOT EXISTS listing_image_sync_settings_listing_idx
  ON public.listing_image_sync_settings (user_id, listing_id);

ALTER TABLE public.listing_image_sync_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_image_sync_settings_user ON public.listing_image_sync_settings;
CREATE POLICY listing_image_sync_settings_user ON public.listing_image_sync_settings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
