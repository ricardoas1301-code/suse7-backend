-- Colunas críticas admissions (hardening 6.9A.10)
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'billing_billable_sale_admissions'
  and column_name in (
    'cycle_limit_snapshot',
    'cycle_origin',
    'official_sale_at',
    'idempotency_key',
    'reservation_expires_at',
    'user_id',
    'subscription_id',
    'marketplace_order_id'
  )
order by column_name;
