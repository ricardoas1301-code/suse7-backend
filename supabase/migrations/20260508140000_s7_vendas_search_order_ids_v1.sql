-- ======================================================================
-- Busca /vendas: pedidos por código ML, pack, texto do raw_json (rastreio,
-- comprador no payload) e nome persistido em marketplace_customers.
-- ======================================================================

CREATE OR REPLACE FUNCTION public.s7_vendas_search_order_ids_v1(
  p_user_id uuid,
  p_q text,
  p_limit int DEFAULT 800
)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT o.id
  FROM public.sales_orders o
  WHERE o.user_id = p_user_id
    AND coalesce(trim(p_q), '') <> ''
    AND (
      o.external_order_id ILIKE ('%' || trim(p_q) || '%')
      OR (o.raw_json::text) ILIKE ('%' || trim(p_q) || '%')
      OR EXISTS (
        SELECT 1
        FROM public.marketplace_customers mc
        WHERE mc.user_id = o.user_id
          AND mc.name ILIKE ('%' || trim(p_q) || '%')
          AND trim(mc.external_customer_id) = trim(COALESCE(o.raw_json -> 'buyer' ->> 'id', ''))
      )
    )
  ORDER BY o.date_created_marketplace DESC NULLS LAST,
    o.created_at DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(nullif(p_limit, 0), 800), 2000));
$$;

GRANT EXECUTE ON FUNCTION public.s7_vendas_search_order_ids_v1(uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.s7_vendas_search_order_ids_v1(uuid, text, int) TO service_role;

COMMENT ON FUNCTION public.s7_vendas_search_order_ids_v1(uuid, text, int) IS
  'IDs de sales_orders do usuário cujo código/pack/raw_json/nome de marketplace_customers casa com p_q (lista /vendas).';
