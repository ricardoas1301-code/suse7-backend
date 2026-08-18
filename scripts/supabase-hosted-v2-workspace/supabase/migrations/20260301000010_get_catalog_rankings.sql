-- ======================================================================
-- RPC: get_catalog_rankings(p_user_id uuid) -> jsonb
-- Rankings do catálogo (vendas, faturamento, lucro). Hoje retorna listas
-- vazias até existirem fatos de venda / agregados no banco.
-- Substituir o corpo por SELECTs reais (views materializadas, etc.) quando
-- a integração de pedidos e anúncios estiver ativa.
-- ======================================================================

CREATE OR REPLACE FUNCTION public.get_catalog_rankings(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'top_sales_quantity', '[]'::jsonb,
    'top_revenue', '[]'::jsonb,
    'top_profit', '[]'::jsonb,
    'meta', jsonb_build_object(
      'populated', false,
      'message', 'Substituir por agregação real quando vendas estiverem modeladas.'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.get_catalog_rankings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_catalog_rankings(uuid) TO service_role;

COMMENT ON FUNCTION public.get_catalog_rankings(uuid) IS
  'Suse7: top 10 produtos por vendas, faturamento e lucro (jsonb). Evoluir com dados reais.';
