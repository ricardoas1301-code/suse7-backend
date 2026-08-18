-- ======================================================================
-- S7 | RLS multi-tenant — marketplace listings, vendas, snapshots, schema interno
-- Fases 1–5 do Mission Control (rls_disabled_in_public).
--
-- Contrato:
--   • authenticated → auth.uid() = user_id (fase 1) ou ownership via marketplace_listings / sales_orders
--   • service_role → bypass RLS (Supabase) + GRANT ALL explícito
--   • anon → sem policies (nega por padrão com RLS ON)
--
-- Aplicar primeiro em DEV; validar login, dashboards, sync ML, jobs, webhooks; depois PROD.
-- Idempotente: IF to_regclass + DROP POLICY IF EXISTS.
-- ======================================================================

-- ----------------------------------------------------------------------
-- Helpers (schema private — não expostos via API)
-- ----------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS s7_private;

CREATE OR REPLACE FUNCTION s7_private.apply_user_id_tenant_rls(p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RAISE NOTICE 's7 RLS skip (missing): public.%', p_table;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);

  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_select ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_insert ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_update ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_delete ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_all ON public.%I', p_table, p_table);

  EXECUTE format(
    'CREATE POLICY s7_%1$I_authenticated_select ON public.%1$I FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()))',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY s7_%1$I_authenticated_insert ON public.%1$I FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()))',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY s7_%1$I_authenticated_update ON public.%1$I FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()))',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY s7_%1$I_authenticated_delete ON public.%1$I FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()))',
    p_table
  );

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_listing_child_tenant_rls(p_table text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.' || p_table) IS NULL THEN
    RAISE NOTICE 's7 RLS skip (missing): public.%', p_table;
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);

  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_select ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_insert ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_update ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_delete ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_all ON public.%I', p_table, p_table);

  EXECUTE format(
    $pol$
    CREATE POLICY s7_%1$I_authenticated_select ON public.%1$I
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.marketplace_listings ml
          WHERE ml.id = %1$I.listing_id
            AND ml.user_id = (SELECT auth.uid())
        )
      )
    $pol$,
    p_table
  );

  EXECUTE format(
    $pol$
    CREATE POLICY s7_%1$I_authenticated_insert ON public.%1$I
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.marketplace_listings ml
          WHERE ml.id = %1$I.listing_id
            AND ml.user_id = (SELECT auth.uid())
        )
      )
    $pol$,
    p_table
  );

  EXECUTE format(
    $pol$
    CREATE POLICY s7_%1$I_authenticated_update ON public.%1$I
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.marketplace_listings ml
          WHERE ml.id = %1$I.listing_id
            AND ml.user_id = (SELECT auth.uid())
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.marketplace_listings ml
          WHERE ml.id = %1$I.listing_id
            AND ml.user_id = (SELECT auth.uid())
        )
      )
    $pol$,
    p_table
  );

  EXECUTE format(
    $pol$
    CREATE POLICY s7_%1$I_authenticated_delete ON public.%1$I
      FOR DELETE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.marketplace_listings ml
          WHERE ml.id = %1$I.listing_id
            AND ml.user_id = (SELECT auth.uid())
        )
      )
    $pol$,
    p_table
  );

  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_order_raw_snapshots_tenant_rls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.order_raw_snapshots') IS NULL THEN
    RAISE NOTICE 's7 RLS skip (missing): public.order_raw_snapshots';
    RETURN;
  END IF;

  ALTER TABLE public.order_raw_snapshots ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS s7_order_raw_snapshots_authenticated_select ON public.order_raw_snapshots;
  DROP POLICY IF EXISTS s7_order_raw_snapshots_authenticated_insert ON public.order_raw_snapshots;
  DROP POLICY IF EXISTS s7_order_raw_snapshots_authenticated_update ON public.order_raw_snapshots;
  DROP POLICY IF EXISTS s7_order_raw_snapshots_authenticated_delete ON public.order_raw_snapshots;
  DROP POLICY IF EXISTS s7_order_raw_snapshots_authenticated_all ON public.order_raw_snapshots;

  CREATE POLICY s7_order_raw_snapshots_authenticated_select
    ON public.order_raw_snapshots
    FOR SELECT TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.sales_orders so
        WHERE so.id = order_raw_snapshots.sales_order_id
          AND so.user_id = (SELECT auth.uid())
      )
    );

  CREATE POLICY s7_order_raw_snapshots_authenticated_insert
    ON public.order_raw_snapshots
    FOR INSERT TO authenticated
    WITH CHECK (
      EXISTS (
        SELECT 1
        FROM public.sales_orders so
        WHERE so.id = order_raw_snapshots.sales_order_id
          AND so.user_id = (SELECT auth.uid())
      )
    );

  CREATE POLICY s7_order_raw_snapshots_authenticated_update
    ON public.order_raw_snapshots
    FOR UPDATE TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.sales_orders so
        WHERE so.id = order_raw_snapshots.sales_order_id
          AND so.user_id = (SELECT auth.uid())
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1
        FROM public.sales_orders so
        WHERE so.id = order_raw_snapshots.sales_order_id
          AND so.user_id = (SELECT auth.uid())
      )
    );

  CREATE POLICY s7_order_raw_snapshots_authenticated_delete
    ON public.order_raw_snapshots
    FOR DELETE TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.sales_orders so
        WHERE so.id = order_raw_snapshots.sales_order_id
          AND so.user_id = (SELECT auth.uid())
      )
    );

  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_raw_snapshots TO authenticated;
  GRANT ALL ON TABLE public.order_raw_snapshots TO service_role;
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_s7_schema_migrations_lockdown()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.s7_schema_migrations') IS NULL THEN
    RAISE NOTICE 's7 RLS skip (missing): public.s7_schema_migrations';
    RETURN;
  END IF;

  ALTER TABLE public.s7_schema_migrations ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS s7_s7_schema_migrations_authenticated_select ON public.s7_schema_migrations;
  DROP POLICY IF EXISTS s7_s7_schema_migrations_authenticated_insert ON public.s7_schema_migrations;
  DROP POLICY IF EXISTS s7_s7_schema_migrations_authenticated_update ON public.s7_schema_migrations;
  DROP POLICY IF EXISTS s7_s7_schema_migrations_authenticated_delete ON public.s7_schema_migrations;
  DROP POLICY IF EXISTS s7_s7_schema_migrations_authenticated_all ON public.s7_schema_migrations;

  REVOKE ALL ON TABLE public.s7_schema_migrations FROM PUBLIC;
  REVOKE ALL ON TABLE public.s7_schema_migrations FROM anon;
  REVOKE ALL ON TABLE public.s7_schema_migrations FROM authenticated;

  GRANT ALL ON TABLE public.s7_schema_migrations TO service_role;
END;
$$;

-- ----------------------------------------------------------------------
-- FASE 1 — ownership direto (user_id)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_user_id_tenant_rls('marketplace_listings');
SELECT s7_private.apply_user_id_tenant_rls('sales_orders');
SELECT s7_private.apply_user_id_tenant_rls('sales_order_items');
SELECT s7_private.apply_user_id_tenant_rls('listing_sales_metrics');
SELECT s7_private.apply_user_id_tenant_rls('marketplace_listing_health');
SELECT s7_private.apply_user_id_tenant_rls('marketplace_listing_health_history');

-- ----------------------------------------------------------------------
-- FASE 2 — ownership via marketplace_listings.listing_id
-- ----------------------------------------------------------------------
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_attributes');
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_descriptions');
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_pictures');
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_shipping');
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_variations');
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_raw_snapshots');
SELECT s7_private.apply_listing_child_tenant_rls('marketplace_listing_snapshots');

-- ----------------------------------------------------------------------
-- FASE 3 — snapshots de pedidos
-- ----------------------------------------------------------------------
SELECT s7_private.apply_order_raw_snapshots_tenant_rls();

-- ----------------------------------------------------------------------
-- FASE 4 — tabela interna (sem acesso anon/authenticated)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_s7_schema_migrations_lockdown();

-- ----------------------------------------------------------------------
-- FASE 5 — grants já aplicados pelos helpers acima
-- ----------------------------------------------------------------------

REVOKE ALL ON SCHEMA s7_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA s7_private FROM PUBLIC;
GRANT USAGE ON SCHEMA s7_private TO service_role;
