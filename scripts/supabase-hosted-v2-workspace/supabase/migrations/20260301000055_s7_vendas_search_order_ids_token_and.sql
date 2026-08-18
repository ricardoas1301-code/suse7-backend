-- ======================================================================
-- Refino busca /vendas: cada palavra (token) deve aparecer — AND — no
-- critério escolhido; entre critérios (código do pedido vs raw_json vs
-- nome em marketplace_customers) vale OR. Atualiza s7_vendas_search_order_ids_v1.
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
  WITH tokens AS (
    SELECT trim(t) AS tok
    FROM unnest(regexp_split_to_array(trim(p_q), E'\\s+')) AS t
    WHERE length(trim(t)) > 0
  )
  SELECT o.id
  FROM public.sales_orders o
  WHERE o.user_id = p_user_id
    AND coalesce(trim(p_q), '') <> ''
    AND EXISTS (SELECT 1 FROM tokens)
    AND (
      COALESCE(
        (
          SELECT bool_and(o.external_order_id ILIKE ('%' || tokens.tok || '%'))
          FROM tokens
        ),
        false
      )
      OR COALESCE(
        (
          SELECT bool_and((o.raw_json::text) ILIKE ('%' || tokens.tok || '%'))
          FROM tokens
        ),
        false
      )
      OR EXISTS (
        SELECT 1
        FROM public.marketplace_customers mc
        WHERE mc.user_id = o.user_id
          AND trim(mc.external_customer_id) = trim(COALESCE(o.raw_json -> 'buyer' ->> 'id', ''))
          AND COALESCE(
            (
              SELECT bool_and(mc.name ILIKE ('%' || tokens.tok || '%'))
              FROM tokens
            ),
            false
          )
      )
    )
  ORDER BY o.date_created_marketplace DESC NULLS LAST,
    o.created_at DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(nullif(p_limit, 0), 800), 2000));
$$;
