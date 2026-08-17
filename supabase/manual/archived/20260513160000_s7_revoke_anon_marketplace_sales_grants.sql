-- ======================================================================
-- ARQUIVADA — não usar via supabase db push
--
-- Motivo: timestamp duplicado com 20260513160000_s7_billing_042_limits_enforcement.sql
-- No DEV remoto, o slot 20260513160000 já foi consumido pelo billing_042.
-- Conteúdo superseded por: migrations/20260624120000_s7_rls_public_schema_hardening_s4.sql
--   (REVOKE anon + RLS via apply_user_id_tenant_rls / lockdown helpers)
-- ======================================================================

-- (conteúdo original preservado abaixo para referência)

CREATE SCHEMA IF NOT EXISTS s7_private;

CREATE OR REPLACE FUNCTION s7_private.revoke_anon_marketplace_sales_grants(p_table text, p_grant_authenticated boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RAISE NOTICE 's7 anon revoke skip (missing): public.%', p_table;
    RETURN;
  END IF;

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', p_table);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);

  IF p_grant_authenticated THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', p_table);
  ELSE
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', p_table);
  END IF;

  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listings');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_attributes');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_descriptions');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_health');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_health_history');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_pictures');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_raw_snapshots');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_shipping');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_snapshots');
SELECT s7_private.revoke_anon_marketplace_sales_grants('marketplace_listing_variations');
SELECT s7_private.revoke_anon_marketplace_sales_grants('listing_sales_metrics');
SELECT s7_private.revoke_anon_marketplace_sales_grants('sales_orders');
SELECT s7_private.revoke_anon_marketplace_sales_grants('sales_order_items');
SELECT s7_private.revoke_anon_marketplace_sales_grants('order_raw_snapshots');
SELECT s7_private.revoke_anon_marketplace_sales_grants('s7_schema_migrations', false);

REVOKE ALL ON SCHEMA s7_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA s7_private FROM PUBLIC;
GRANT USAGE ON SCHEMA s7_private TO service_role;
