-- Motivo textual de pendência operacional (ex.: sku_pending_ml quando o ML não envia SKU).
ALTER TABLE public.marketplace_listings
  ADD COLUMN IF NOT EXISTS attention_reason text NULL;

COMMENT ON COLUMN public.marketplace_listings.attention_reason IS
  'Código de pendência operacional. Ex.: sku_pending_ml = anúncio sem SKU no ML; informar SKU no Suse7 para vincular produto.';
