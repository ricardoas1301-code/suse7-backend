-- ======================================================================
-- S1.HF.6.9A.10 — PRE-CHECK read-only (robusto)
-- Sobrevive a tabela/coluna/metadata inválidos (validação textual).
-- ======================================================================

SELECT 'table_exists' AS check_id,
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'billing_billable_sale_admissions'
  ) AS ok;

SELECT 'sale_origin_strategy' AS check_id,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_order_items'
      AND column_name = 'raw_json'
  ) AS has_items_raw_json,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders'
      AND column_name = 'date_created_marketplace'
  ) AS has_official_date,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales_order_items' AND column_name = 'raw_json'
    ) THEN 'primary=date_created_marketplace; optional_origin=sales_order_items.raw_json._s7_financial.snapshot_origin'
    ELSE 'primary=date_created_marketplace; origin_column_unavailable'
  END AS strategy;

DO $$
DECLARE
  r record;
  v_ambiguous integer := 0;
  v_zero_canon integer := 0;
  v_stale integer := 0;
BEGIN
  IF to_regclass('public.billing_subscriptions') IS NULL OR to_regclass('public.sales_orders') IS NULL THEN
    RAISE NOTICE 'classification skipped: dependencia ausente';
    RETURN;
  END IF;

  FOR r IN
    SELECT bs.user_id, COUNT(*) AS baby_candidates
    FROM public.billing_subscriptions bs
    WHERE COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1','TRUE')
      AND COALESCE(bs.metadata->>'effective_entitlement','') = 'BABY_INTERNAL_FREE'
    GROUP BY bs.user_id
  LOOP
    IF r.baby_candidates > 1 THEN
      v_ambiguous := v_ambiguous + 1;
      RAISE NOTICE 'ambiguous_canonical_user user_id=% baby_candidates=%', r.user_id, r.baby_candidates;
    END IF;
  END LOOP;

  SELECT COUNT(DISTINCT u.user_id) INTO v_zero_canon
  FROM (SELECT DISTINCT user_id FROM public.sales_orders) u
  WHERE NOT EXISTS (
    SELECT 1 FROM public.billing_subscriptions bs
    WHERE bs.user_id = u.user_id
      AND COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1','TRUE')
      AND COALESCE(bs.metadata->>'effective_entitlement','') = 'BABY_INTERNAL_FREE'
  )
  AND EXISTS (
    SELECT 1 FROM public.billing_subscriptions bs2
    WHERE bs2.user_id = u.user_id
      AND COALESCE(bs2.metadata->>'trial_state','') IN ('EXPIRED','CONVERTED')
  );

  SELECT COUNT(*) INTO v_stale
  FROM public.billing_subscriptions bs
  WHERE COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1','TRUE')
    AND lower(COALESCE(bs.status,'')) IN ('canceled','cancelled','refunded','superseded');

  RAISE NOTICE 'canonical_summary ambiguous_users=% zero_or_unclear=% stale_fallback=%',
    v_ambiguous, v_zero_canon, v_stale;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.billing_subscriptions') IS NULL OR to_regclass('public.sales_orders') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN EXECUTE $q$
    SELECT
      bs.id AS subscription_id,
      COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key',''), NULLIF(bs.metadata->>'fallback_period_start','')) AS cycle_key,
      NULLIF(bs.metadata->>'quota_counting_started_at','') AS quota_counting_started_at,
      (
        SELECT COUNT(*)::integer FROM (
          SELECT DISTINCT so.marketplace, so.marketplace_account_id, so.external_order_id
          FROM public.sales_orders so
          WHERE so.user_id = bs.user_id
            AND so.date_created_marketplace IS NOT NULL
            AND NULLIF(bs.metadata->>'operational_cutover_at','') ~ '^[0-9]{4}-'
            AND so.date_created_marketplace < (bs.metadata->>'operational_cutover_at')::timestamptz
        ) x
      ) AS pre_cutover_count,
      -- Histórico: proxy por pré-cutover (coluna origin dedicada ausente em sales_orders)
      (
        SELECT COUNT(*)::integer FROM (
          SELECT DISTINCT so.marketplace, so.marketplace_account_id, so.external_order_id
          FROM public.sales_orders so
          WHERE so.user_id = bs.user_id
            AND so.date_created_marketplace IS NOT NULL
            AND NULLIF(bs.metadata->>'operational_cutover_at','') ~ '^[0-9]{4}-'
            AND so.date_created_marketplace < (bs.metadata->>'operational_cutover_at')::timestamptz
        ) x
      ) AS imported_historical_count,
      (
        SELECT COUNT(*)::integer FROM (
          SELECT DISTINCT so.marketplace, so.marketplace_account_id, so.external_order_id
          FROM public.sales_orders so
          WHERE so.user_id = bs.user_id
            AND so.date_created_marketplace IS NOT NULL
            AND NULLIF(bs.metadata->>'quota_counting_started_at','') ~ '^[0-9]{4}-'
            AND so.date_created_marketplace >= (bs.metadata->>'quota_counting_started_at')::timestamptz
            AND (
              COALESCE(NULLIF(bs.metadata->>'fallback_period_start',''), NULLIF(bs.metadata->>'usage_limit_cycle_key','')) IS NULL
              OR so.date_created_marketplace < (
                COALESCE(NULLIF(bs.metadata->>'fallback_period_start',''), NULLIF(bs.metadata->>'usage_limit_cycle_key',''))
                || 'T00:00:00.000Z'
              )::timestamptz
            )
        ) x
      ) AS trial_observed_count,
      (
        SELECT COUNT(*)::integer FROM (
          SELECT DISTINCT so.marketplace, so.marketplace_account_id, so.external_order_id
          FROM public.sales_orders so
          JOIN public.marketplace_accounts ma
            ON ma.id = so.marketplace_account_id
           AND ma.user_id = bs.user_id
           AND ma.marketplace = so.marketplace
          WHERE so.user_id = bs.user_id
            AND so.marketplace IS NOT NULL AND btrim(so.marketplace) <> ''
            AND so.marketplace_account_id IS NOT NULL
            AND so.external_order_id IS NOT NULL AND btrim(so.external_order_id) <> ''
            AND so.date_created_marketplace IS NOT NULL
            AND NULLIF(bs.metadata->>'quota_counting_started_at','') ~ '^[0-9]{4}-'
            AND NULLIF(bs.metadata->>'fallback_period_end','') ~ '^[0-9]{4}-'
            AND so.date_created_marketplace >= GREATEST(
              (bs.metadata->>'quota_counting_started_at')::timestamptz,
              (
                COALESCE(NULLIF(bs.metadata->>'fallback_period_start',''), NULLIF(bs.metadata->>'usage_limit_cycle_key',''))
                || 'T00:00:00.000Z'
              )::timestamptz
            )
            AND so.date_created_marketplace <= (bs.metadata->>'fallback_period_end' || 'T23:59:59.999Z')::timestamptz
        ) x
      ) AS current_cycle_eligible_count,
      (
        SELECT COUNT(*)::integer
        FROM public.billing_billable_sale_admissions a
        WHERE a.subscription_id = bs.id
          AND a.cycle_key = COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key',''), NULLIF(bs.metadata->>'fallback_period_start',''))
          AND a.admission_result IN ('RESERVED','PERSISTED','RECOVERY_REQUIRED')
      ) AS admissions_active_count,
      (
        SELECT COUNT(*)::integer FROM public.sales_orders so
        WHERE so.user_id = bs.user_id
          AND (
            so.marketplace IS NULL OR btrim(so.marketplace) = ''
            OR so.marketplace_account_id IS NULL
            OR so.external_order_id IS NULL OR btrim(so.external_order_id) = ''
          )
      ) AS incomplete_identity_count
    FROM public.billing_subscriptions bs
    WHERE COALESCE(bs.metadata->>'suspension_fallback_active','') IN ('true','t','1','TRUE')
      AND COALESCE(bs.metadata->>'effective_entitlement','') = 'BABY_INTERNAL_FREE'
  $q$ LOOP
    RAISE NOTICE 'cycle_classification subscription_id=% cycle_key=% imported_historical=% pre_cutover=% trial_observed=% current_cycle_eligible=% admissions=% eligible_difference=% incomplete_identity=%',
      r.subscription_id, r.cycle_key, r.imported_historical_count, r.pre_cutover_count, r.trial_observed_count,
      r.current_cycle_eligible_count, r.admissions_active_count,
      (r.current_cycle_eligible_count - r.admissions_active_count),
      r.incomplete_identity_count;
  END LOOP;
END $$;

DO $$
DECLARE
  v_dups integer := -1;
BEGIN
  IF to_regclass('public.billing_billable_sale_admissions') IS NULL THEN
    RAISE NOTICE 'duplicate_active_admissions skipped: table absent';
    RETURN;
  END IF;
  EXECUTE $q$
    SELECT COUNT(*)::integer FROM (
      SELECT 1
      FROM public.billing_billable_sale_admissions
      WHERE admission_result IN ('RESERVED','PERSISTED','RECOVERY_REQUIRED')
      GROUP BY subscription_id, cycle_key, marketplace, marketplace_account_id, external_order_id
      HAVING COUNT(*) > 1
    ) d
  $q$ INTO v_dups;
  RAISE NOTICE 'duplicate_active_admissions duplicate_groups=%', v_dups;
END $$;

SELECT 'table_rls' AS check_id, c.relname, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('billing_billable_sale_admissions', 'billing_internal_deployment_identity');

SELECT 'table_policies' AS check_id, c.relname, COUNT(pol.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relname IN ('billing_billable_sale_admissions', 'billing_internal_deployment_identity')
GROUP BY c.relname;

SELECT 'table_grants' AS check_id, table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN ('billing_billable_sale_admissions', 'billing_internal_deployment_identity')
  AND grantee IN ('PUBLIC','anon','authenticated','service_role');

SELECT 'constraints' AS check_id, con.conname, con.contype
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'billing_billable_sale_admissions';

SELECT 'indexes' AS check_id, i.relname AS index_name, pg_get_indexdef(i.oid) AS indexdef
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'billing_billable_sale_admissions';

SELECT 'precheck_complete' AS check_id, true AS ok;
