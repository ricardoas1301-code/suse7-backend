-- =====================================================================
-- RESET CONTROLADO — catálogo ML importado (DEV APENAS)
-- =====================================================================
--
-- ANTES DE CORRER:
--   1) Confirma no Supabase Dashboard que estás no projeto **DEV** (ref/url).
--   2) Executa dev-ml-catalog-snapshot.sql e guarda o resultado.
--   3) Opcional: limita a um único user_id (descomenta os filtros marcados).
--
-- O QUE ESTE SCRIPT REMOVE (Mercado Livre / slug legado mercadolivre):
--   • marketplace_listings (+ CASCADE: descriptions, attributes, pictures,
--     variations, shipping, raw_snapshots, change_events)
--   • marketplace_listing_health (não tem FK para listings)
--   • listing_sales_metrics (agregados por anúncio; serão refeitos no sync-sales)
--
-- O QUE NÃO TOCA:
--   • auth.users, profiles, user_preferences, ml_tokens, produtos (products),
--     imagens de produto, sales_orders, sales_order_items, order_raw_snapshots
--   • notificações, drafts, etc.
--
-- VÍNCULOS listing ↔ product:
--   As linhas de anúncio deixam de existir; product_id some com elas.
--   **Não apagamos produtos.** Depois da reimportação, o fluxo de vínculo
--   (SKU / product link) pode recriar product_id se as regras baterem.
--
-- ORDEM: DELETE health + metrics primeiro (sem dependência de listing uuid),
--        depois listings (cascade limpa o resto).
--
-- =====================================================================

BEGIN;

-- [optional user filter] Repete em cada DELETE se precisares:
-- AND user_id = '00000000-0000-0000-0000-000000000001'::uuid

DELETE FROM public.marketplace_listing_health
WHERE marketplace IN ('mercado_livre', 'mercadolivre');

DELETE FROM public.listing_sales_metrics
WHERE marketplace IN ('mercado_livre', 'mercadolivre');

DELETE FROM public.marketplace_listings
WHERE marketplace IN ('mercado_livre', 'mercadolivre');

COMMIT;

-- Verificação rápida (deve tudo ser 0 para ML):
-- SELECT
--   (SELECT count(*) FROM marketplace_listings WHERE marketplace IN ('mercado_livre','mercadolivre')) AS listings_left,
--   (SELECT count(*) FROM marketplace_listing_health WHERE marketplace IN ('mercado_livre','mercadolivre')) AS health_left,
--   (SELECT count(*) FROM listing_sales_metrics WHERE marketplace IN ('mercado_livre','mercadolivre')) AS metrics_left;
