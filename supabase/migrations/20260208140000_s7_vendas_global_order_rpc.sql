-- ======================================================================
-- S7 | Vendas — ordenação global por data do marketplace + RPC de página
-- NOTA: cliente backend usa service_role → auth.uid() aqui era NULL.
-- Aplicar também: 20260208150000_s7_vendas_rpc_p_user_id_hotfix.sql
-- ======================================================================
-- Ordenação: date_created_marketplace DESC NULLS LAST, sales_orders.created_at DESC,
--            sales_order_items.created_at DESC, sales_order_items.id DESC
-- marketplace_account_id / seller_company_id NÃO entram como critério primário.
-- ======================================================================

ALTER TABLE IF EXISTS public.sales_order_items
  ADD COLUMN IF NOT EXISTS thumbnail_snapshot text;

-- ======================================================================
-- RPC: página estável alinhada à ordenação global (usa auth.uid())
-- ======================================================================
CREATE OR REPLACE FUNCTION public.s7_sales_order_items_page_v1(
  p_marketplace text DEFAULT NULL,
  p_q text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT soi.id
    FROM public.sales_order_items soi
    INNER JOIN public.sales_orders so ON so.id = soi.sales_order_id AND so.user_id = auth.uid()
    WHERE soi.user_id = auth.uid()
      AND (
        p_marketplace IS NULL
        OR length(trim(p_marketplace)) = 0
        OR trim(lower(soi.marketplace)) = trim(lower(p_marketplace))
      )
      AND (
        p_q IS NULL
        OR length(trim(p_q)) = 0
        OR (
          COALESCE(soi.title_snapshot::text, '') ILIKE '%'
            || trim(replace(replace(p_q, '*', ''), ',', ' '))
            || '%'
          OR COALESCE(soi.sku_snapshot::text, '') ILIKE '%'
            || trim(replace(replace(p_q, '*', ''), ',', ' '))
            || '%'
          OR COALESCE(soi.external_listing_id::text, '') ILIKE '%'
            || trim(replace(replace(p_q, '*', ''), ',', ' '))
            || '%'
          OR COALESCE(soi.external_order_item_id::text, '') ILIKE '%'
            || trim(replace(replace(p_q, '*', ''), ',', ' '))
            || '%'
          OR COALESCE(soi.external_order_id::text, '') ILIKE '%'
            || trim(replace(replace(p_q, '*', ''), ',', ' '))
            || '%'
        )
      )
  ),
  counted AS (
    SELECT COUNT(*)::bigint AS c FROM filtered
  ),
  page_rows AS (
    SELECT soi.id AS item_id,
           so.date_created_marketplace AS d_mp,
           so.created_at AS d_so,
           soi.created_at AS d_soi
    FROM public.sales_order_items soi
    INNER JOIN public.sales_orders so ON so.id = soi.sales_order_id
    WHERE soi.id IN (SELECT id FROM filtered)
    ORDER BY so.date_created_marketplace DESC NULLS LAST,
             so.created_at DESC NULLS LAST,
             soi.created_at DESC NULLS LAST,
             soi.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT c FROM counted),
    'ids', COALESCE(
      (
        SELECT jsonb_agg(pr.item_id ORDER BY
          pr.d_mp DESC NULLS LAST,
          pr.d_so DESC NULLS LAST,
          pr.d_soi DESC NULLS LAST,
          pr.item_id DESC
        )
        FROM page_rows pr
      ),
      '[]'::jsonb
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.s7_sales_order_items_page_v1(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.s7_sales_order_items_page_v1(text, text, int, int) TO service_role;
