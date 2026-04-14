-- Suse7 — payout oficial ML (health + snapshots). Paridade com supabase/migrations 20260409140000.
-- Idempotente.

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
