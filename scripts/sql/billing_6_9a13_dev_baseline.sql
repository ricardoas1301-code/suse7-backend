-- S1.HF.6.9A.13 — baseline DEV (somente leitura)
-- Projeto esperado: Suse7-dev (ujznkyvgqhxagemdgmor)

SELECT current_database() AS db,
       current_user AS db_user,
       NOW() AT TIME ZONE 'America/Sao_Paulo' AS now_sp;

SELECT 'billing_billable_sale_admissions' AS obj,
       to_regclass('public.billing_billable_sale_admissions') IS NOT NULL AS exists
UNION ALL SELECT 'billing_trial_lifecycle_transitions',
       to_regclass('public.billing_trial_lifecycle_transitions') IS NOT NULL
UNION ALL SELECT 'billing_trial_lifecycle_job_locks',
       to_regclass('public.billing_trial_lifecycle_job_locks') IS NOT NULL
UNION ALL SELECT 'billing_paid_lifecycle_ledger',
       to_regclass('public.billing_paid_lifecycle_ledger') IS NOT NULL
UNION ALL SELECT 'billing_paid_lifecycle_job_locks',
       to_regclass('public.billing_paid_lifecycle_job_locks') IS NOT NULL
UNION ALL SELECT 'billing_internal_deployment_identity',
       to_regclass('public.billing_internal_deployment_identity') IS NOT NULL
UNION ALL SELECT 's7_notification_event_types',
       to_regclass('public.s7_notification_event_types') IS NOT NULL;

SELECT p.proname AS rpc
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'billing_admit_billable_sale_v1',
    'billing_reserve_billable_sale_v2',
    'billing_finalize_billable_sale_v2',
    'billing_reconcile_expired_billable_sale_reservations_v1',
    'billing_internal_resolve_access_precedence',
    'billing_trial_lifecycle_apply_transition',
    'billing_trial_lifecycle_try_acquire_job_lock',
    'billing_paid_lifecycle_apply_transition',
    'billing_paid_lifecycle_try_acquire_job_lock'
  )
ORDER BY 1;

SELECT category_code, type_key, is_active
FROM public.s7_notification_event_types
WHERE category_code = 'BILLING'
  AND type_key IN (
    'TRIAL_ENDING_D3','TRIAL_ENDING_D2','TRIAL_ENDING_D1','TRIAL_EXPIRED',
    'RENEWAL_AVAILABLE','PAYMENT_PENDING','PAYMENT_DUE','GRACE_LAST_DAY',
    'BABY_FALLBACK_ACTIVATED','PAYMENT_CONFIRMED','ENTERED_GRACE','SUSPENDED',
    'REACTIVATED','PAYMENT_FAILED'
  )
ORDER BY type_key;

SELECT
  (SELECT COUNT(*) FROM public.billing_subscriptions) AS billing_subscriptions_count,
  (SELECT COUNT(*) FROM public.billing_payments) AS billing_payments_count,
  (SELECT COUNT(*) FROM public.billing_billable_sale_admissions) AS admissions_count;
