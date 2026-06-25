-- ======================================================================
-- Concorrência — status oficial do anúncio concorrente (Mercado Livre)
-- Registro vivo em competition_competitors; histórico em raw_snapshot.
-- Não remove concorrente automaticamente — apenas sinalização.
-- ======================================================================

ALTER TABLE public.competition_competitors
  ADD COLUMN IF NOT EXISTS competitor_listing_status text NULL;

COMMENT ON COLUMN public.competition_competitors.competitor_listing_status IS
  'Status oficial do anúncio no marketplace (ex.: active, paused, closed, not_found). Atualizado pela rotina diária e enrich.';

CREATE INDEX IF NOT EXISTS competition_competitors_listing_status_idx
  ON public.competition_competitors (competitor_listing_status)
  WHERE is_active = true;
