-- ======================================================================
-- DEV.V2.SECURITY-EXPOSURE-PRECONNECT.11
-- Hardening PostgREST/RPC antes de conectar app ao Fresh DEV V2.
-- Forward-safe · idempotente · Git = source of truth.
-- ======================================================================

-- ----------------------------------------------------------------------
-- A) Tabelas public sem RLS (Security Advisor ERROR)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_service_role_only_lockdown('marketplace_account_sales_import_coverage');
SELECT s7_private.apply_service_role_only_lockdown('billing_customer_notification_policy');

-- ----------------------------------------------------------------------
-- B) Legacy SECURITY DEFINER — service_role only (sem caller no backend/frontend)
-- ----------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_ml_token_for_user',
        'refresh_ml_tokens_for_user',
        'iniciar_teste_gratis',
        'reset_monthly_usage',
        'register_log',
        'registrar_precificacao',
        'delete_old_logs',
        'calcular_precificacao_automatica',
        'verificar_limite_plano'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- search_path fix em SECURITY DEFINER legadas
ALTER FUNCTION public.get_ml_token_for_user(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.refresh_ml_tokens_for_user(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.iniciar_teste_gratis(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_monthly_usage() SET search_path = public, pg_temp;
ALTER FUNCTION public.register_log(uuid, text, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.registrar_precificacao(uuid, numeric) SET search_path = public, pg_temp;
ALTER FUNCTION public.delete_old_logs(integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.current_auth_uid() SET search_path = public, pg_temp;
ALTER FUNCTION public.calcular_precificacao_automatica(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.verificar_limite_plano(uuid) SET search_path = public, pg_temp;

-- calcular_precificacao (math helpers) — anon ok, mas fix search_path
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'calcular_precificacao'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.sig);
  END LOOP;
END $$;

-- normalize/sync helpers
ALTER FUNCTION public.normalize_ad_title(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_products_normalized_sku() SET search_path = public, pg_temp;

-- ----------------------------------------------------------------------
-- C) RPCs tenant-safe — authenticated only (revoke anon)
-- ----------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'update_product_image_links_sort_order',
        'update_product_variants_sort_order',
        's7_sales_order_items_page_v1',
        's7_vendas_search_order_ids_v1'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- s7 vendas RPCs: search_path
ALTER FUNCTION public.s7_sales_order_items_page_v1(uuid, text, text, int, int) SET search_path = public, pg_temp;
ALTER FUNCTION public.s7_vendas_search_order_ids_v1(uuid, text, int) SET search_path = public, pg_temp;

-- ----------------------------------------------------------------------
-- D) Trigger helpers — não são RPC públicas
-- ----------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.trigger_set_timestamp() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_set_updated_at() FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.trigger_set_timestamp() SET search_path = public, pg_temp;
ALTER FUNCTION public.trigger_set_updated_at() SET search_path = public, pg_temp;

-- set_title_normalized trigger helper se existir
DO $$
BEGIN
  IF to_regprocedure('public.set_title_normalized_product_ad_titles()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.set_title_normalized_product_ad_titles() FROM PUBLIC, anon, authenticated;
    ALTER FUNCTION public.set_title_normalized_product_ad_titles() SET search_path = public, pg_temp;
  END IF;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- ----------------------------------------------------------------------
-- F) Reafirmar RPCs já endurecidas mas re-expostas por DEFAULT PRIVILEGES / CREATE OR REPLACE
-- ----------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_catalog_rankings(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_catalog_rankings(uuid) TO service_role;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'snapshot_marketplace_listing_health'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'billing_internal_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END $$;

-- search_path pendente em helpers trigger/dev
ALTER FUNCTION public.normalize_sku(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.s7_competition_enforce_active_limit() SET search_path = public, pg_temp;
ALTER FUNCTION public.s7_touch_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;

-- ----------------------------------------------------------------------
-- G) Default privileges — impedir novas functions anon/authenticated por default
-- ----------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM authenticated;

COMMENT ON SCHEMA public IS
  'S7 public schema — DEV.V2.SECURITY-EXPOSURE-PRECONNECT.11 hardening applied. '
  'RPC internas: service_role only. Tenant RPCs: authenticated + ownership/RLS.';
