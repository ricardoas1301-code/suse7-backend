-- Bridge: RPC backend (20260208140000) referencia external_order_id em sales_order_items.
-- Phase3 cria external_order_item_id; multiconta (20260506) adiciona external_order_id depois no timestamp.
-- Fresh replay precisa da coluna antes do RPC backend.

ALTER TABLE IF EXISTS public.sales_order_items
  ADD COLUMN IF NOT EXISTS external_order_id text;

COMMENT ON COLUMN public.sales_order_items.external_order_id IS 'ID externo do pedido no marketplace (compat RPC vendas; multiconta reforça depois).';
