-- ======================================================================
-- S1.HF.6.9A.10 — POST-GRANT DEV — allowlist exata nome+assinatura
-- Um único resumo final ok=true somente se toda a matriz passar.
-- ======================================================================

WITH operational(proname, args) AS (
  VALUES
    ('billing_reserve_billable_sale_v2', 'uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamp with time zone, text'),
    ('billing_finalize_billable_sale_v2', 'uuid, uuid, uuid, timestamp with time zone'),
    ('billing_release_billable_sale_v2', 'uuid, uuid, uuid, text'),
    ('billing_reconcile_expired_billable_sale_reservations_v1', 'integer'),
    ('billing_renew_billable_sale_reservation_lease_v2', 'uuid, uuid, uuid'),
    ('billing_report_billable_sale_finalize_failure_v2', 'uuid, uuid, uuid, text'),
    ('billing_count_admitted_billable_sales', 'uuid, text')
),
internal_or_v1(proname, args) AS (
  VALUES
    ('billing_count_active_billable_slots', 'uuid, text'),
    ('billing_internal_resolve_baby_admission_context', 'uuid, uuid, text, integer'),
    ('billing_internal_read_open_cycle_snapshot', 'uuid'),
    ('billing_internal_build_admission_idempotency_key', 'uuid, text, text, uuid, text'),
    ('billing_internal_read_plan_sales_limit_from_catalog', 'text'),
    ('billing_internal_materialize_open_cycle_sales_limit_snapshot', 'uuid'),
    ('billing_internal_resolve_current_baby_cycle', 'uuid, uuid'),
    ('billing_internal_validate_marketplace_account', 'uuid, text, uuid'),
    ('billing_internal_sync_subscription_usage_count', 'uuid, text, jsonb, timestamp with time zone'),
    ('billing_internal_finalize_admission_row', 'uuid, timestamp with time zone'),
    ('billing_internal_release_admission_row', 'uuid, text'),
    ('billing_internal_expire_admission_row', 'uuid, text'),
    ('billing_internal_mark_recovery_required', 'uuid, text, text'),
    ('billing_internal_reconcile_admission_row', 'uuid'),
    ('billing_admit_billable_sale_v1', 'uuid, uuid, text, text, text, uuid, integer, boolean'),
    ('billing_rollback_billable_sale_admission_v1', 'uuid, uuid')
),
op_found AS (
  SELECT o.*, p.oid
  FROM operational o
  LEFT JOIN pg_proc p
    ON p.proname = o.proname
   AND pg_get_function_identity_arguments(p.oid) = o.args
   AND p.pronamespace = 'public'::regnamespace
),
int_found AS (
  SELECT i.*, p.oid
  FROM internal_or_v1 i
  LEFT JOIN pg_proc p
    ON p.proname = i.proname
   AND pg_get_function_identity_arguments(p.oid) = i.args
   AND p.pronamespace = 'public'::regnamespace
)
SELECT 'postgrant_matrix_final' AS check_id,
  (SELECT COUNT(*) FROM op_found WHERE oid IS NOT NULL AND has_function_privilege('service_role', oid, 'EXECUTE')) AS operational_service_role_execute,
  (SELECT COUNT(*) FROM int_found WHERE oid IS NOT NULL AND has_function_privilege('service_role', oid, 'EXECUTE')) AS internal_v1_service_role_execute,
  (
    SELECT COUNT(*) FROM (
      SELECT oid FROM op_found WHERE oid IS NOT NULL
      UNION ALL
      SELECT oid FROM int_found WHERE oid IS NOT NULL
    ) x
    CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = x.oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = x.oid)))) acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) AS public_execute,
  (
    SELECT COUNT(*) FROM (
      SELECT oid FROM op_found WHERE oid IS NOT NULL
      UNION ALL
      SELECT oid FROM int_found WHERE oid IS NOT NULL
    ) x
    WHERE has_function_privilege('anon', x.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', x.oid, 'EXECUTE')
  ) AS anon_authenticated_execute,
  (
    SELECT COUNT(*) FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('billing_billable_sale_admissions','billing_internal_deployment_identity')
      AND grantee IN ('PUBLIC','anon','authenticated','service_role')
  ) AS table_direct_grants,
  (
    SELECT COUNT(pol.polname)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_policy pol ON pol.polrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname IN ('billing_billable_sale_admissions','billing_internal_deployment_identity')
  ) AS public_policies,
  (
    (SELECT COUNT(*) FROM op_found WHERE oid IS NOT NULL AND has_function_privilege('service_role', oid, 'EXECUTE')) = 7
    AND (SELECT COUNT(*) FROM int_found WHERE oid IS NOT NULL AND has_function_privilege('service_role', oid, 'EXECUTE')) = 0
    AND (
      SELECT COUNT(*) FROM (
        SELECT oid FROM op_found WHERE oid IS NOT NULL
        UNION ALL
        SELECT oid FROM int_found WHERE oid IS NOT NULL
      ) x
      CROSS JOIN LATERAL aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = x.oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = x.oid)))) acl
      WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) = 0
    AND (
      SELECT COUNT(*) FROM (
        SELECT oid FROM op_found WHERE oid IS NOT NULL
        UNION ALL
        SELECT oid FROM int_found WHERE oid IS NOT NULL
      ) x
      WHERE has_function_privilege('anon', x.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', x.oid, 'EXECUTE')
    ) = 0
    AND (
      SELECT COUNT(*) FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND table_name IN ('billing_billable_sale_admissions','billing_internal_deployment_identity')
        AND grantee IN ('PUBLIC','anon','authenticated','service_role')
    ) = 0
    AND (
      SELECT COUNT(pol.polname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policy pol ON pol.polrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relname IN ('billing_billable_sale_admissions','billing_internal_deployment_identity')
    ) = 0
  ) AS ok;

SELECT 'operational_detail' AS check_id, o.proname, o.args,
  p.oid IS NOT NULL AS found,
  CASE WHEN p.oid IS NULL THEN false ELSE has_function_privilege('service_role', p.oid, 'EXECUTE') END AS service_role_execute
FROM (
  VALUES
    ('billing_reserve_billable_sale_v2', 'uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamp with time zone, text'),
    ('billing_finalize_billable_sale_v2', 'uuid, uuid, uuid, timestamp with time zone'),
    ('billing_release_billable_sale_v2', 'uuid, uuid, uuid, text'),
    ('billing_reconcile_expired_billable_sale_reservations_v1', 'integer'),
    ('billing_renew_billable_sale_reservation_lease_v2', 'uuid, uuid, uuid'),
    ('billing_report_billable_sale_finalize_failure_v2', 'uuid, uuid, uuid, text'),
    ('billing_count_admitted_billable_sales', 'uuid, text')
) AS o(proname, args)
LEFT JOIN pg_proc p
  ON p.proname = o.proname
 AND pg_get_function_identity_arguments(p.oid) = o.args
 AND p.pronamespace = 'public'::regnamespace
ORDER BY o.proname;
