-- Suse7 — payout oficial ML: colunas em health + marketplace_payout_amount em snapshots
-- Idempotente (IF NOT EXISTS).

ALTER TABLE public.marketplace_listing_health
  ADD COLUMN IF NOT EXISTS marketplace_sale_price_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS marketplace_payout_currency text DEFAULT 'BRL',
  ADD COLUMN IF NOT EXISTS marketplace_payout_synced_at timestamptz;

ALTER TABLE public.marketplace_listing_snapshots
  ADD COLUMN IF NOT EXISTS marketplace_payout_amount numeric(14, 2);

UPDATE public.marketplace_listing_snapshots
SET marketplace_payout_amount = round(net_receivable::numeric, 2)
WHERE marketplace_payout_amount IS NULL
  AND net_receivable IS NOT NULL;

COMMENT ON COLUMN public.marketplace_listing_health.marketplace_sale_price_amount IS
  'Preço de venda efetivo no sync ML (base de taxas/repasse).';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_payout_currency IS
  'Moeda do repasse oficial (ex.: BRL).';
COMMENT ON COLUMN public.marketplace_listing_health.marketplace_payout_synced_at IS
  'Timestamp em que marketplace_payout_amount foi sincronizado com o ML.';
COMMENT ON COLUMN public.marketplace_listing_snapshots.marketplace_payout_amount IS
  'Repasse “Você recebe” na captura (espelha health.marketplace_payout_amount).';
