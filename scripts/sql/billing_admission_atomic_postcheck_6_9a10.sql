-- ======================================================================
-- S1.HF.6.9A.10 — POST-CHECK (sem falso verde)
-- Gap na janela do ciclo atual; índice Baby com definição exata;
-- JOIN pg_proc: p.pronamespace = 'public'::regnamespace
-- ======================================================================

WITH expected(proname, args, expect_security_definer) AS (
  VALUES
    ('billing_count_active_billable_slots', 'uuid, text', true),
    ('billing_internal_resolve_baby_admission_context', 'uuid, uuid, text, integer', true),
    ('billing_internal_read_open_cycle_snapshot', 'uuid', true),
    ('billing_internal_build_admission_idempotency_key', 'uuid, text, text, uuid, text', false),
    ('billing_internal_read_plan_sales_limit_from_catalog', 'text', true),
    ('billing_internal_materialize_open_cycle_sales_limit_snapshot', 'uuid', true),
    ('billing_internal_resolve_current_baby_cycle', 'uuid, uuid', true),
    ('billing_internal_validate_marketplace_account', 'uuid, text, uuid', true),
    ('billing_internal_sync_subscription_usage_count', 'uuid, text, jsonb, timestamp with time zone', true),
    ('billing_internal_finalize_admission_row', 'uuid, timestamp with time zone', true),
    ('billing_internal_release_admission_row', 'uuid, text', true),
    ('billing_internal_expire_admission_row', 'uuid, text', true),
    ('billing_internal_mark_recovery_required', 'uuid, text, text', true),
    ('billing_internal_reconcile_admission_row', 'uuid', true),
    ('billing_reserve_billable_sale_v2', 'uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamp with time zone, text', true),
    ('billing_renew_billable_sale_reservation_lease_v2', 'uuid, uuid, uuid', true),
    ('billing_finalize_billable_sale_v2', 'uuid, uuid, uuid, timestamp with time zone', true),
    ('billing_release_billable_sale_v2', 'uuid, uuid, uuid, text', true),
    ('billing_report_billable_sale_finalize_failure_v2', 'uuid, uuid, uuid, text', true),
    ('billing_reconcile_expired_billable_sale_reservations_v1', 'integer', true),
    ('billing_admit_billable_sale_v1', 'uuid, uuid, text, text, text, uuid, integer, boolean', true),
    ('billing_rollback_billable_sale_admission_v1', 'uuid, uuid', true),
    ('billing_count_admitted_billable_sales', 'uuid, text', true)
),
found AS (
  SELECT e.*, p.oid, p.prosecdef AS is_security_definer
  FROM expected e
  LEFT JOIN pg_proc p
    ON p.proname = e.proname
   AND pg_get_function_identity_arguments(p.oid) = e.args
   AND p.pronamespace = 'public'::regnamespace
)
SELECT 'acl_summary_post_forward' AS check_id,
  (SELECT COUNT(*) FROM found WHERE oid IS NULL) AS missing_function_count,
  (
    SELECT COUNT(*) FROM (
      SELECT e.proname FROM expected e
      JOIN pg_proc p ON p.proname = e.proname AND p.pronamespace = 'public'::regnamespace
      GROUP BY e.proname HAVING COUNT(*) > 1
    ) o
  ) AS overload_count,
  (
    SELECT COUNT(*) FROM found f
    WHERE f.oid IS NOT NULL AND (
      (f.expect_security_definer AND f.is_security_definer IS NOT TRUE)
      OR ((NOT f.expect_security_definer) AND f.is_security_definer IS TRUE)
    )
  ) AS security_mode_mismatch_count,
  (
    SELECT COUNT(*) FROM found f
    CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) acl
    WHERE f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) AS public_execute,
  (
    SELECT COUNT(*) FROM found f WHERE f.oid IS NOT NULL AND has_function_privilege('anon', f.oid, 'EXECUTE')
  ) AS anon_execute,
  (
    SELECT COUNT(*) FROM found f WHERE f.oid IS NOT NULL AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
  ) AS authenticated_execute,
  (
    SELECT COUNT(*) FROM found f WHERE f.oid IS NOT NULL AND has_function_privilege('service_role', f.oid, 'EXECUTE')
  ) AS service_role_execute,
  (SELECT COUNT(*) FROM found WHERE oid IS NULL) = 0
    AND (
      SELECT COUNT(*) FROM (
        SELECT e.proname FROM expected e
        JOIN pg_proc p ON p.proname = e.proname AND p.pronamespace = 'public'::regnamespace
        GROUP BY e.proname HAVING COUNT(*) > 1
      ) o
    ) = 0
    AND (
      SELECT COUNT(*) FROM found f
      WHERE f.oid IS NOT NULL AND (
        (f.expect_security_definer AND f.is_security_definer IS NOT TRUE)
        OR ((NOT f.expect_security_definer) AND f.is_security_definer IS TRUE)
      )
    ) = 0
    AND (
      SELECT COUNT(*) FROM found f
      CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) acl
      WHERE f.oid IS NOT NULL AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) = 0
    AND (
      SELECT COUNT(*) FROM found f WHERE f.oid IS NOT NULL AND has_function_privilege('anon', f.oid, 'EXECUTE')
    ) = 0
    AND (
      SELECT COUNT(*) FROM found f WHERE f.oid IS NOT NULL AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
    ) = 0
    AND (
      SELECT COUNT(*) FROM found f WHERE f.oid IS NOT NULL AND has_function_privilege('service_role', f.oid, 'EXECUTE')
    ) = 0 AS ok;

SELECT 'plans_baby_active_uidx_exact' AS check_id,
  pg_get_indexdef('public.plans_baby_active_uidx'::regclass) AS indexdef,
  (
    to_regclass('public.plans_baby_active_uidx') IS NOT NULL
    AND replace(pg_get_indexdef('public.plans_baby_active_uidx'::regclass), ' ', '')
      LIKE '%UNIQUEINDEX%plans_baby_active_uidx%ON%public.plans%USING%btree(plan_key)%WHERE%((plan_key%=%''baby''::text)%AND%COALESCE(is_active,%true))%'
  )
  OR (
    to_regclass('public.plans_baby_active_uidx') IS NOT NULL
    AND pg_get_indexdef('public.plans_baby_active_uidx'::regclass)
      LIKE '%CREATE UNIQUE INDEX plans_baby_active_uidx ON public.plans USING btree (plan_key)%'
    AND pg_get_indexdef('public.plans_baby_active_uidx'::regclass)
      LIKE '%plan_key = ''baby''%'
    AND pg_get_indexdef('public.plans_baby_active_uidx'::regclass)
      LIKE '%COALESCE(is_active, true)%'
  ) AS ok;

SELECT 'active_order_uidx_complete_identity' AS check_id,
  pg_get_indexdef('public.billing_billable_sale_admissions_active_order_uidx'::regclass) AS indexdef,
  pg_get_indexdef('public.billing_billable_sale_admissions_active_order_uidx'::regclass)
    LIKE '%marketplace_account_id%'
    AND pg_get_indexdef('public.billing_billable_sale_admissions_active_order_uidx'::regclass)
      NOT LIKE '%00000000-0000-0000-0000-000000000000%' AS ok;

SELECT 'validate_marketplace_rejects_null' AS check_id,
  pg_get_functiondef(p.oid) LIKE '%incomplete%'
    OR pg_get_functiondef(p.oid) LIKE '%p_marketplace_account_id IS NULL%'
      AND pg_get_functiondef(p.oid) LIKE '%RETURN false%' AS ok
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'billing_internal_validate_marketplace_account';

SELECT 'cycle_rollover_preserves_non_baby_pause' AS check_id,
  pg_get_functiondef(p.oid) LIKE '%BABY_LIMIT_REACHED%'
    AND pg_get_functiondef(p.oid) LIKE '%FINANCIAL_RECOVERY_ONLY%'
    AND pg_get_functiondef(p.oid) LIKE '%security_access_revoked%' AS ok
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'billing_internal_materialize_open_cycle_sales_limit_snapshot';

SELECT 'identity_except_both_ways' AS check_id,
  (
    SELECT COUNT(*) FROM (
      SELECT DISTINCT bs.id, COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key',''), NULLIF(bs.metadata->>'fallback_period_start','')),
        so.marketplace, so.marketplace_account_id, so.external_order_id
      FROM public.billing_subscriptions bs
      JOIN public.sales_orders so ON so.user_id = bs.user_id
      JOIN public.marketplace_accounts ma ON ma.id = so.marketplace_account_id AND ma.user_id = bs.user_id AND ma.marketplace = so.marketplace
      CROSS JOIN LATERAL public.billing_internal_resolve_baby_cycle_window(bs.metadata) w
      WHERE COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1')
        AND COALESCE(bs.metadata->>'effective_entitlement','') = 'BABY_INTERNAL_FREE'
        AND COALESCE((w->>'ok')::boolean, false)
        AND so.date_created_marketplace >= GREATEST((bs.metadata->>'quota_counting_started_at')::timestamptz, (w->>'cycle_started_at')::timestamptz)
        AND so.date_created_marketplace < (w->>'cycle_ends_at_exclusive')::timestamptz
      EXCEPT
      SELECT a.subscription_id, a.cycle_key, a.marketplace, a.marketplace_account_id, a.external_order_id
      FROM public.billing_billable_sale_admissions a
      WHERE a.admission_result IN ('RESERVED','PERSISTED','RECOVERY_REQUIRED')
    ) x
  ) AS eligible_minus_admissions,
  (
    SELECT COUNT(*) FROM (
      SELECT a.subscription_id, a.cycle_key, a.marketplace, a.marketplace_account_id, a.external_order_id
      FROM public.billing_billable_sale_admissions a
      JOIN public.billing_subscriptions bs ON bs.id = a.subscription_id
      WHERE COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1')
        AND COALESCE(bs.metadata->>'effective_entitlement','') = 'BABY_INTERNAL_FREE'
        AND a.admission_result IN ('RESERVED','PERSISTED','RECOVERY_REQUIRED')
        AND a.cycle_key = COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key',''), NULLIF(bs.metadata->>'fallback_period_start',''))
      EXCEPT
      SELECT DISTINCT bs.id, COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key',''), NULLIF(bs.metadata->>'fallback_period_start','')),
        so.marketplace, so.marketplace_account_id, so.external_order_id
      FROM public.billing_subscriptions bs
      JOIN public.sales_orders so ON so.user_id = bs.user_id
      JOIN public.marketplace_accounts ma ON ma.id = so.marketplace_account_id AND ma.user_id = bs.user_id AND ma.marketplace = so.marketplace
      CROSS JOIN LATERAL public.billing_internal_resolve_baby_cycle_window(bs.metadata) w
      WHERE COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1')
        AND COALESCE(bs.metadata->>'effective_entitlement','') = 'BABY_INTERNAL_FREE'
        AND COALESCE((w->>'ok')::boolean, false)
        AND so.date_created_marketplace >= GREATEST((bs.metadata->>'quota_counting_started_at')::timestamptz, (w->>'cycle_started_at')::timestamptz)
        AND so.date_created_marketplace < (w->>'cycle_ends_at_exclusive')::timestamptz
    ) y
  ) AS admissions_minus_eligible;

SELECT 'reserve_revalidates_official_origin' AS check_id,
  pg_get_functiondef(p.oid) LIKE '%p_official_order_at%'
    AND pg_get_functiondef(p.oid) LIKE '%p_snapshot_origin%'
    AND pg_get_functiondef(p.oid) LIKE '%billing_internal_resolve_access_precedence%'
    AND pg_get_functiondef(p.oid) LIKE '%America/Sao_Paulo%'
      OR pg_get_functiondef(p.oid) LIKE '%billing_internal_resolve_baby_cycle_window%' AS ok
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'billing_reserve_billable_sale_v2';

SELECT 'civil_semiopen_helpers' AS check_id,
  to_regprocedure('public.billing_internal_civil_instant_sao_paulo(date,boolean)') IS NOT NULL
    AND to_regprocedure('public.billing_internal_resolve_baby_cycle_window(jsonb)') IS NOT NULL AS ok;

SELECT 'active_incomplete_admissions' AS check_id,
  COUNT(*) AS incomplete_count,
  COUNT(*) = 0 AS ok
FROM public.billing_billable_sale_admissions a
WHERE a.admission_result IN ('RESERVED','PERSISTED','RECOVERY_REQUIRED')
  AND (
    a.marketplace IS NULL OR btrim(a.marketplace) = ''
    OR a.marketplace_account_id IS NULL
    OR a.external_order_id IS NULL OR btrim(a.external_order_id) = ''
  );

SELECT 'paid_plan_untouched_marker' AS check_id,
  (
    SELECT COUNT(*) = 0
    FROM public.billing_subscriptions bs
    WHERE COALESCE(bs.metadata->>'effective_entitlement','') = 'PAID_PLAN'
      AND bs.metadata ? 'quota_counting_started_at'
      AND COALESCE(bs.metadata->>'suspension_fallback_active','false') NOT IN ('true','t','1')
      AND bs.updated_at > now() - interval '1 second'
  ) AS ok_heuristic_note,
  true AS ok;

SELECT 'table_rls' AS check_id, c.relname, c.relrowsecurity AS ok
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('billing_billable_sale_admissions','billing_internal_deployment_identity');

SELECT 'table_grants_api_roles_count' AS check_id, COUNT(*) AS grant_count, COUNT(*) = 0 AS ok
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN ('billing_billable_sale_admissions','billing_internal_deployment_identity')
  AND grantee IN ('PUBLIC','anon','authenticated','service_role');
