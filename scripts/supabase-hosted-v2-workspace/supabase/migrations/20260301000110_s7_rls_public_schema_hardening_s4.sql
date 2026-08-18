-- ======================================================================
-- S7-S4 | RLS hardening — schema public (gaps pós-Security Advisor)
--
-- Contrato (inalterado):
--   • authenticated → tenant via auth.uid() (= user_id | seller_id | profiles.id)
--   • service_role → bypass RLS + GRANT ALL
--   • anon → sem policies / REVOKE (nega por padrão com RLS ON)
--
-- Idempotente. Aplicar DEV → homologar → PROD.
-- Auditoria pós-apply: supabase/diagnostics/s7_rls_public_schema_full_audit.sql
--
-- Nota: substitui também manual/archived/20260513160000_s7_revoke_anon_* (timestamp
-- duplicado com billing_042 — nunca entrou no histórico remoto).
-- ======================================================================

CREATE SCHEMA IF NOT EXISTS s7_private;

-- Reutiliza helpers da trilha marketplace/vendas (CREATE OR REPLACE idempotente)
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

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_seller_id_tenant_rls(p_table text)
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

  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_select ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_insert ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_update ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_delete ON public.%I', p_table, p_table);

  EXECUTE format(
    'CREATE POLICY s7_%1$I_seller_select ON public.%1$I FOR SELECT TO authenticated USING (seller_id = (SELECT auth.uid()))',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY s7_%1$I_seller_insert ON public.%1$I FOR INSERT TO authenticated WITH CHECK (seller_id = (SELECT auth.uid()))',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY s7_%1$I_seller_update ON public.%1$I FOR UPDATE TO authenticated USING (seller_id = (SELECT auth.uid())) WITH CHECK (seller_id = (SELECT auth.uid()))',
    p_table
  );
  EXECUTE format(
    'CREATE POLICY s7_%1$I_seller_delete ON public.%1$I FOR DELETE TO authenticated USING (seller_id = (SELECT auth.uid()))',
    p_table
  );

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_profiles_self_rls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE 's7 RLS skip (missing): public.profiles';
    RETURN;
  END IF;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS s7_profiles_authenticated_select ON public.profiles;
  DROP POLICY IF EXISTS s7_profiles_authenticated_insert ON public.profiles;
  DROP POLICY IF EXISTS s7_profiles_authenticated_update ON public.profiles;
  DROP POLICY IF EXISTS s7_profiles_authenticated_delete ON public.profiles;

  CREATE POLICY s7_profiles_authenticated_select
    ON public.profiles FOR SELECT TO authenticated
    USING (id = (SELECT auth.uid()));

  CREATE POLICY s7_profiles_authenticated_insert
    ON public.profiles FOR INSERT TO authenticated
    WITH CHECK (id = (SELECT auth.uid()));

  CREATE POLICY s7_profiles_authenticated_update
    ON public.profiles FOR UPDATE TO authenticated
    USING (id = (SELECT auth.uid()))
    WITH CHECK (id = (SELECT auth.uid()));

  CREATE POLICY s7_profiles_authenticated_delete
    ON public.profiles FOR DELETE TO authenticated
    USING (id = (SELECT auth.uid()));

  REVOKE ALL ON TABLE public.profiles FROM anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
  GRANT ALL ON TABLE public.profiles TO service_role;
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_product_child_tenant_rls(p_table text)
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

  EXECUTE format(
    $pol$
    CREATE POLICY s7_%1$I_authenticated_select ON public.%1$I
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.products p
          WHERE p.id = %1$I.product_id
            AND p.user_id = (SELECT auth.uid())
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
          SELECT 1 FROM public.products p
          WHERE p.id = %1$I.product_id
            AND p.user_id = (SELECT auth.uid())
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
          SELECT 1 FROM public.products p
          WHERE p.id = %1$I.product_id
            AND p.user_id = (SELECT auth.uid())
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.products p
          WHERE p.id = %1$I.product_id
            AND p.user_id = (SELECT auth.uid())
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
          SELECT 1 FROM public.products p
          WHERE p.id = %1$I.product_id
            AND p.user_id = (SELECT auth.uid())
        )
      )
    $pol$,
    p_table
  );

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_service_role_only_lockdown(p_table text)
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
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_select ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_insert ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_update ON public.%I', p_table, p_table);
  EXECUTE format('DROP POLICY IF EXISTS s7_%I_seller_delete ON public.%I', p_table, p_table);

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', p_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', p_table);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

CREATE OR REPLACE FUNCTION s7_private.apply_authenticated_read_catalog(p_table text, p_predicate text DEFAULT 'true')
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

  EXECUTE format('DROP POLICY IF EXISTS s7_%I_authenticated_select_catalog ON public.%I', p_table, p_table);

  EXECUTE format(
    'CREATE POLICY s7_%1$I_authenticated_select_catalog ON public.%1$I FOR SELECT TO authenticated USING (%2$s)',
    p_table,
    p_predicate
  );

  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', p_table);
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', p_table);
  EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', p_table);
END;
$$;

-- ----------------------------------------------------------------------
-- A) Catálogo operacional SUS7 — frontend Supabase client (authenticated)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_profiles_self_rls();
SELECT s7_private.apply_user_id_tenant_rls('products');
SELECT s7_private.apply_product_child_tenant_rls('product_variants');
SELECT s7_private.apply_user_id_tenant_rls('product_image_links');

-- ----------------------------------------------------------------------
-- B) Contas, empresas, clientes marketplace
-- ----------------------------------------------------------------------
SELECT s7_private.apply_user_id_tenant_rls('marketplace_accounts');
SELECT s7_private.apply_user_id_tenant_rls('seller_companies');
SELECT s7_private.apply_user_id_tenant_rls('marketplace_customers');

-- ----------------------------------------------------------------------
-- C) Billing seller-scoped (defesa em profundidade; UI via API)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_user_id_tenant_rls('billing_customers');
SELECT s7_private.apply_user_id_tenant_rls('billing_subscriptions');
SELECT s7_private.apply_user_id_tenant_rls('billing_payments');
SELECT s7_private.apply_user_id_tenant_rls('billing_monthly_usage');
SELECT s7_private.apply_user_id_tenant_rls('billing_usage_snapshots');
SELECT s7_private.apply_user_id_tenant_rls('billing_usage_events');

-- Catálogo de planos (somente leitura)
SELECT s7_private.apply_authenticated_read_catalog('plans', 'true');
SELECT s7_private.apply_authenticated_read_catalog('billing_plan_limits', 'true');

-- ----------------------------------------------------------------------
-- D) Notificações — legado Fase 1/2 + motor central S7
-- ----------------------------------------------------------------------
SELECT s7_private.apply_user_id_tenant_rls('notification_contacts');
SELECT s7_private.apply_user_id_tenant_rls('notification_routing_rules');
SELECT s7_private.apply_user_id_tenant_rls('notification_events');
SELECT s7_private.apply_user_id_tenant_rls('notification_deliveries');
SELECT s7_private.apply_service_role_only_lockdown('notification_delivery_logs');

SELECT s7_private.apply_seller_id_tenant_rls('s7_notification_events');
SELECT s7_private.apply_seller_id_tenant_rls('s7_notification_dispatches');
SELECT s7_private.apply_authenticated_read_catalog('s7_notification_categories', 'is_active = true');
SELECT s7_private.apply_authenticated_read_catalog('s7_notification_event_types', 'is_active = true');
SELECT s7_private.apply_authenticated_read_catalog('s7_notification_templates', 'is_active = true');
SELECT s7_private.apply_service_role_only_lockdown('s7_notification_template_versions');

-- Outbox / workers — somente service_role
SELECT s7_private.apply_service_role_only_lockdown('s7_notification_email_outbox');
SELECT s7_private.apply_service_role_only_lockdown('s7_notification_whatsapp_outbox');
SELECT s7_private.apply_service_role_only_lockdown('s7_notification_popup_deliveries');
SELECT s7_private.apply_service_role_only_lockdown('s7_notification_delivery_logs');

-- ----------------------------------------------------------------------
-- E) Integrações / filas — backend, cron, webhooks (service_role only)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_service_role_only_lockdown('ml_tokens');
SELECT s7_private.apply_service_role_only_lockdown('oauth_states');
SELECT s7_private.apply_service_role_only_lockdown('ml_webhook_events');
SELECT s7_private.apply_service_role_only_lockdown('marketplace_account_sync_jobs');
SELECT s7_private.apply_service_role_only_lockdown('billing_webhook_events');
SELECT s7_private.apply_service_role_only_lockdown('billing_events');
SELECT s7_private.apply_service_role_only_lockdown('billing_analytics_snapshots');

-- Dev Center — operação interna
SELECT s7_private.apply_service_role_only_lockdown('dev_center_seller_feature_flags');
SELECT s7_private.apply_service_role_only_lockdown('dev_center_toolbox_operational_audit');

-- Sininho legado (se existir)
SELECT s7_private.apply_user_id_tenant_rls('notifications');

-- ----------------------------------------------------------------------
-- F) Reafirmar trilha marketplace/vendas (idempotente)
-- ----------------------------------------------------------------------
SELECT s7_private.apply_user_id_tenant_rls('marketplace_listings');
SELECT s7_private.apply_user_id_tenant_rls('sales_orders');
SELECT s7_private.apply_user_id_tenant_rls('sales_order_items');
SELECT s7_private.apply_user_id_tenant_rls('listing_sales_metrics');
SELECT s7_private.apply_user_id_tenant_rls('marketplace_listing_health');
SELECT s7_private.apply_user_id_tenant_rls('marketplace_listing_health_history');

REVOKE ALL ON SCHEMA s7_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA s7_private FROM PUBLIC;
GRANT USAGE ON SCHEMA s7_private TO service_role;
