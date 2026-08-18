-- =============================================================================
-- Fase 2.1 — no máximo 1 renewal cycle OPEN por subscription_id
-- =============================================================================

-- 1) Deduplicar ciclos OPEN existentes (mantém o mais avançado por assinatura)
WITH open_cycles AS (
  SELECT
    id,
    subscription_id,
    renewal_status,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY subscription_id
      ORDER BY
        CASE renewal_status
          WHEN 'SUSPENDED' THEN 0
          WHEN 'GRACE_PERIOD' THEN 1
          WHEN 'PAYMENT_FAILED' THEN 2
          WHEN 'AUTO_CHARGE_PROCESSING' THEN 3
          WHEN 'PENDING_PAYMENT' THEN 4
          WHEN 'PRE_RENEWAL' THEN 5
          WHEN 'SCHEDULED' THEN 6
          ELSE 99
        END,
        created_at DESC,
        id DESC
    ) AS rn
  FROM public.billing_renewal_cycles
  WHERE renewal_status IN (
    'SCHEDULED',
    'PRE_RENEWAL',
    'PENDING_PAYMENT',
    'AUTO_CHARGE_PROCESSING',
    'PAYMENT_FAILED',
    'GRACE_PERIOD',
    'SUSPENDED'
  )
),
to_supersede AS (
  SELECT id
  FROM open_cycles
  WHERE rn > 1
)
UPDATE public.billing_renewal_cycles AS c
SET
  renewal_status = 'SUPERSEDED',
  updated_at = timezone('utc', now()),
  metadata = COALESCE(c.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'superseded_at', timezone('utc', now()),
      'superseded_reason', 'migration_one_open_cycle_dedup'
    )
FROM to_supersede AS s
WHERE c.id = s.id;

-- 2) Índice único parcial — proteção em concorrência / workers paralelos
CREATE UNIQUE INDEX IF NOT EXISTS billing_renewal_cycles_one_open_per_subscription_idx
  ON public.billing_renewal_cycles (subscription_id)
  WHERE renewal_status IN (
    'SCHEDULED',
    'PRE_RENEWAL',
    'PENDING_PAYMENT',
    'AUTO_CHARGE_PROCESSING',
    'PAYMENT_FAILED',
    'GRACE_PERIOD',
    'SUSPENDED'
  );

COMMENT ON INDEX billing_renewal_cycles_one_open_per_subscription_idx IS
  'Fase 2.1: garante no máximo 1 renewal cycle OPEN por billing subscription.';
