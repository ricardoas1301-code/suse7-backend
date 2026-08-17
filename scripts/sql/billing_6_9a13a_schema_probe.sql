-- S1.HF.6.9A.13A — probe schema DEV (sem PII, read-only)
select 'identity' as section,
  environment::text as a,
  project_ref::text as b,
  null::text as c
from billing_internal_deployment_identity where id = 1

union all
select 'table', c.relname, null, null
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in (
    'billing_billable_sale_admissions',
    'billing_internal_deployment_identity',
    'billing_trial_lifecycle_transitions',
    'billing_trial_lifecycle_job_locks',
    'billing_paid_lifecycle_ledger',
    'billing_paid_lifecycle_job_locks'
  )

union all
select 'rpc', p.proname, pg_get_function_identity_arguments(p.oid),
  CASE WHEN prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'billing_reserve_billable_sale_v2',
    'billing_finalize_billable_sale_v2',
    'billing_release_billable_sale_v2',
    'billing_reconcile_expired_billable_sale_reservations_v1',
    'billing_trial_lifecycle_apply_transition',
    'billing_trial_lifecycle_try_job_lock',
    'billing_paid_lifecycle_apply_transition',
    'billing_paid_lifecycle_try_job_lock'
  )

union all
select 'constraint', con.conname, rel.relname, contype::text
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and rel.relname in (
    'billing_billable_sale_admissions',
    'billing_trial_lifecycle_transitions',
    'billing_paid_lifecycle_ledger'
  )

union all
select 'index', i.relname, t.relname, null
from pg_index x
join pg_class i on i.oid = x.indexrelid
join pg_class t on t.oid = x.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in (
    'billing_billable_sale_admissions',
    'billing_trial_lifecycle_transitions',
    'billing_paid_lifecycle_ledger',
    'billing_trial_lifecycle_job_locks',
    'billing_paid_lifecycle_job_locks'
  )

union all
select 'seed', type_key, array_to_string(supported_channels, ','), null
from s7_notification_event_types
where type_key in (
  'TRIAL_ENDING_D3','TRIAL_ENDING_D2','TRIAL_ENDING_D1','TRIAL_EXPIRED',
  'RENEWAL_AVAILABLE','GRACE_LAST_DAY','BABY_FALLBACK_ACTIVATED',
  'PAYMENT_CONFIRMED','ENTERED_GRACE','SUSPENDED'
)

order by 1,2;
