#!/usr/bin/env node
/**
 * Gera forward-only 6.9A.10 a partir da migration base (substitui 6.9A.9).
 * Uso: node scripts/generate_billing_admission_hardening_6_9a10.mjs
 * SSOT: falha se forward commitado ≠ regenerado, ou funções base ≠ forward.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basePath = path.join(
  root,
  "supabase/migrations/20260722140000_s7_billing_billable_sale_admission_atomic.sql",
);
const outPath = path.join(
  root,
  "supabase/migrations/20260723140000_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql",
);

const baseRaw = fs.readFileSync(basePath, "utf8");
const base = baseRaw.replace(/\r\n/g, "\n");
const startMarker =
  "-- ======================================================================\n-- Contagem fail-closed: RESERVED sempre ocupa slot até EXPIRED/ROLLED_BACK";
const endMarker = "DO $$\nBEGIN\n  BEGIN REVOKE ALL ON TABLE public.billing_billable_sale_admissions";

const startIdx = base.indexOf(startMarker);
const endIdx = base.indexOf(endMarker);
if (startIdx < 0 || endIdx < 0) {
  console.error("Marcadores não encontrados na migration base");
  process.exit(1);
}

const functionsBlock = base.slice(startIdx, endIdx);
const revokeBlock = base.slice(endIdx);

const preamble = `-- ======================================================================
-- S7 | Billing - hardening forward-only (S1.HF.6.9A.10)
-- PARADA: precheck 6_9a10 antes de executar.
-- PROD-safe: termina sem GRANT service_role.
-- DEV: scripts/sql/billing_admission_atomic_grant_dev_v2_6_9a10.sql
-- Baseline: ciclo civil SP semiaberto ∩ pós quota; identidade EXCEPT=0.
-- ======================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.billing_internal_admission_revoke_execute();
DROP FUNCTION IF EXISTS public.billing_internal_admission_grant_service_role();

DO $$
BEGIN
  BEGIN REVOKE ALL ON TABLE public.billing_billable_sale_admissions FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_admit_billable_sale_v1(uuid, uuid, text, text, text, uuid, integer, boolean) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_rollback_billable_sale_admission_v1(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN REVOKE ALL ON FUNCTION public.billing_count_admitted_billable_sales(uuid, text) FROM PUBLIC, anon, authenticated, service_role; EXCEPTION WHEN undefined_function THEN NULL; END;
END $$;

DO $$
DECLARE
  v_table_exists boolean;
  v_row_count bigint;
  v_bad_results text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'billing_billable_sale_admissions'
  ) INTO v_table_exists;
  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'billing_admission_hardening: tabela billing_billable_sale_admissions ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'billing_admit_billable_sale_v1'
  ) THEN
    RAISE EXCEPTION 'billing_admission_hardening: billing_admit_billable_sale_v1 ausente';
  END IF;
  SELECT COUNT(*) INTO v_row_count FROM public.billing_billable_sale_admissions;
  SELECT string_agg(DISTINCT admission_result, ', ' ORDER BY admission_result)
  INTO v_bad_results
  FROM public.billing_billable_sale_admissions
  WHERE admission_result NOT IN ('ADMITTED', 'REJECTED_QUOTA', 'ROLLED_BACK', 'RESERVED', 'PERSISTED', 'EXPIRED', 'RECOVERY_REQUIRED');
  IF v_bad_results IS NOT NULL THEN
    RAISE EXCEPTION 'billing_admission_hardening: admission_result inesperado(s): %', v_bad_results;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.marketplace_accounts') IS NULL THEN
    RAISE EXCEPTION 'billing_admission_hardening: marketplace_accounts ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_accounts'
      AND column_name = 'id' AND udt_name = 'uuid'
  ) THEN
    RAISE EXCEPTION 'billing_admission_hardening: marketplace_accounts.id incompativel';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_accounts'
      AND column_name = 'user_id' AND udt_name = 'uuid'
  ) THEN
    RAISE EXCEPTION 'billing_admission_hardening: marketplace_accounts.user_id incompativel';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'marketplace_accounts'
      AND column_name = 'marketplace' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'billing_admission_hardening: marketplace_accounts.marketplace incompativel';
  END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN
    RAISE EXCEPTION 'billing_admission_hardening: sales_orders ausente (SSOT reconciliacao)';
  END IF;
  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sales_orders'
      AND (
        (column_name = 'user_id' AND udt_name = 'uuid')
        OR (column_name = 'external_order_id' AND data_type = 'text')
        OR (column_name = 'marketplace' AND data_type = 'text')
        OR (column_name = 'marketplace_account_id' AND udt_name = 'uuid')
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'billing_admission_hardening: sales_orders exige user_id uuid, external_order_id text, marketplace text, marketplace_account_id uuid';
  END IF;
END $$;

ALTER TABLE public.billing_billable_sale_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_billable_sale_admissions FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS usage_limit integer;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS entitlement_type text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS entitlement_source text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS pause_cycle_key text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS pause_reason text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS previous_sync_state text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS previous_usage_state text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS previous_access_profile text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS reservation_owner_token uuid;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS reservation_attempt_id uuid;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS reserved_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS persisted_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS recovery_attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS last_recovery_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS next_recovery_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS recovery_reason text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS reservation_heartbeat_at timestamptz;
ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS cycle_limit_snapshot integer;

UPDATE public.billing_billable_sale_admissions SET recovery_attempt_count = 0 WHERE recovery_attempt_count IS NULL;
UPDATE public.billing_billable_sale_admissions SET reservation_attempt_id = COALESCE(reservation_attempt_id, gen_random_uuid()) WHERE reservation_attempt_id IS NULL;
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN reservation_attempt_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN reservation_attempt_id SET NOT NULL;
UPDATE public.billing_billable_sale_admissions SET updated_at = COALESCE(updated_at, created_at, now()) WHERE updated_at IS NULL;
UPDATE public.billing_billable_sale_admissions
SET idempotency_key = 'legacy:'
  || subscription_id::text || ':'
  || cycle_key || ':'
  || COALESCE(marketplace, '') || ':'
  || COALESCE(marketplace_account_id, '00000000-0000-0000-0000-000000000000'::uuid)::text || ':'
  || external_order_id
WHERE idempotency_key IS NULL OR btrim(idempotency_key) = '';
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN idempotency_key SET NOT NULL;

DO $$
DECLARE v_admitted bigint;
BEGIN
  SELECT COUNT(*) INTO v_admitted FROM public.billing_billable_sale_admissions WHERE admission_result = 'ADMITTED';
  IF v_admitted > 0 THEN
    UPDATE public.billing_billable_sale_admissions
    SET admission_result = 'RESERVED', reserved_at = COALESCE(created_at, now()),
        reservation_expires_at = COALESCE(created_at, now()) + interval '15 minutes',
        reservation_owner_token = COALESCE(reservation_owner_token, gen_random_uuid()),
        reservation_attempt_id = COALESCE(reservation_attempt_id, gen_random_uuid()),
        reservation_heartbeat_at = COALESCE(reservation_heartbeat_at, now()),
        updated_at = now()
    WHERE admission_result = 'ADMITTED';
  END IF;
END $$;

ALTER TABLE public.billing_billable_sale_admissions DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_result_chk;

DO $$
DECLARE v_dup_order bigint; v_dup_idem bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.billing_billable_sale_admissions'::regclass AND conname = 'billing_billable_sale_admissions_unique_order') THEN
    SELECT COUNT(*) INTO v_dup_order FROM (
      SELECT subscription_id, cycle_key,
        COALESCE(marketplace, ''), COALESCE(marketplace_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
        external_order_id, COUNT(*) c
      FROM public.billing_billable_sale_admissions
      WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
      GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1
    ) d;
    IF v_dup_order > 0 THEN RAISE EXCEPTION 'billing_admission_hardening: conflito ativo external_order_id multimarketplace'; END IF;
    ALTER TABLE public.billing_billable_sale_admissions DROP CONSTRAINT billing_billable_sale_admissions_unique_order;
  END IF;
  SELECT COUNT(*) INTO v_dup_order FROM (
    SELECT subscription_id, cycle_key,
      COALESCE(marketplace, ''), COALESCE(marketplace_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
      external_order_id, COUNT(*) c
    FROM public.billing_billable_sale_admissions
    WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
    GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1
  ) d;
  IF v_dup_order > 0 THEN RAISE EXCEPTION 'billing_admission_hardening: duplicidade ativa external_order_id impede indices'; END IF;
  SELECT COUNT(*) INTO v_dup_idem FROM (
    SELECT subscription_id, cycle_key, idempotency_key, COUNT(*) c FROM public.billing_billable_sale_admissions
    WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED') GROUP BY 1,2,3 HAVING COUNT(*) > 1
  ) d;
  IF v_dup_idem > 0 THEN RAISE EXCEPTION 'billing_admission_hardening: duplicidade ativa idempotency_key impede indices'; END IF;
END $$;

ALTER TABLE public.billing_billable_sale_admissions ADD CONSTRAINT billing_billable_sale_admissions_result_chk
  CHECK (admission_result IN ('RESERVED', 'PERSISTED', 'ROLLED_BACK', 'EXPIRED', 'REJECTED_QUOTA', 'RECOVERY_REQUIRED'));

ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS cycle_limit_snapshot integer;

CREATE TABLE IF NOT EXISTS public.billing_internal_deployment_identity (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  environment text NOT NULL,
  project_ref text NOT NULL,
  env_fingerprint text NOT NULL,
  audit_description text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.billing_internal_deployment_identity ADD COLUMN IF NOT EXISTS audit_description text;
ALTER TABLE public.billing_internal_deployment_identity ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.billing_internal_deployment_identity ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
COMMENT ON TABLE public.billing_internal_deployment_identity IS
  'Identidade canonica do ambiente — seed manual DEV; grant DEV consulta esta tabela.';
ALTER TABLE public.billing_internal_deployment_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_internal_deployment_identity FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_plans_cols integer;
  v_baby_active integer;
  v_baby_limit numeric;
  v_missing_snapshot bigint;
  v_legacy_limit bigint;
BEGIN
  IF to_regclass('public.plans') IS NULL THEN
    RAISE EXCEPTION 'billing_admission_hardening: plans ausente';
  END IF;

  SELECT COUNT(*) INTO v_plans_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'plans'
    AND (
      (column_name = 'plan_key' AND data_type = 'text')
      OR (column_name = 'sales_limit_monthly' AND data_type IN ('integer', 'bigint', 'smallint', 'numeric'))
      OR (column_name = 'is_active' AND data_type = 'boolean')
    );
  IF v_plans_cols <> 3 THEN
    RAISE EXCEPTION 'billing_admission_hardening: plans exige plan_key text, sales_limit_monthly numerico, is_active boolean';
  END IF;

  SELECT COUNT(*), MAX(sales_limit_monthly)::numeric
  INTO v_baby_active, v_baby_limit
  FROM public.plans
  WHERE plan_key = 'baby' AND COALESCE(is_active, true);

  IF v_baby_active = 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: nenhum plano Baby ativo no catalogo';
  END IF;
  IF v_baby_active > 1 THEN
    RAISE EXCEPTION 'billing_admission_hardening: mais de um plano Baby ativo no catalogo (=%)', v_baby_active;
  END IF;
  IF v_baby_limit IS NULL OR v_baby_limit <= 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: Baby sales_limit_monthly invalido (=%)', v_baby_limit;
  END IF;
  IF v_baby_limit <> trunc(v_baby_limit) THEN
    RAISE EXCEPTION 'billing_admission_hardening: Baby sales_limit_monthly nao inteiro (=%)', v_baby_limit;
  END IF;
  IF v_baby_limit > 2147483647 THEN
    RAISE EXCEPTION 'billing_admission_hardening: Baby sales_limit_monthly fora do range integer';
  END IF;
  v_baby_limit := trunc(v_baby_limit);

  UPDATE public.billing_subscriptions bs
  SET metadata = COALESCE(bs.metadata, '{}'::jsonb) || jsonb_build_object(
    'usage_limit_cycle_key', COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', '')),
    'sales_limit_snapshot', trunc(v_baby_limit)::integer,
    'sales_limit_snapshot_cycle_key', COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', '')),
    'sales_limit_snapshot_materialized_at', now()
  )
  WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
    AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    AND (
      NULLIF(bs.metadata->>'sales_limit_snapshot', '') IS NULL
      OR NULLIF(bs.metadata->>'sales_limit_snapshot_cycle_key', '') IS NULL
      OR bs.metadata->>'sales_limit_snapshot_cycle_key' IS DISTINCT FROM COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', ''))
    );

  SELECT COUNT(*) INTO v_missing_snapshot
  FROM public.billing_subscriptions bs
  WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
    AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    AND (
      NULLIF(bs.metadata->>'sales_limit_snapshot', '') IS NULL
      OR NULLIF(bs.metadata->>'sales_limit_snapshot_cycle_key', '') IS NULL
      OR NULLIF(bs.metadata->>'sales_limit_snapshot', '')::integer <= 0
    );

  IF v_missing_snapshot > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: Baby ativo sem sales_limit_snapshot canonico (=%)', v_missing_snapshot;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.billing_billable_sale_admissions a
    JOIN public.billing_subscriptions s ON s.id = a.subscription_id
    WHERE a.admission_result IN ('RESERVED', 'ADMITTED', 'RECOVERY_REQUIRED', 'PERSISTED')
      AND a.usage_limit IS NOT NULL
      AND NULLIF(s.metadata->>'sales_limit_snapshot', '')::integer IS NOT NULL
      AND a.usage_limit IS DISTINCT FROM NULLIF(s.metadata->>'sales_limit_snapshot', '')::integer
      AND (a.cycle_limit_snapshot IS NULL OR a.cycle_limit_snapshot <= 0)
  ) THEN
    RAISE EXCEPTION 'billing_admission_hardening: usage_limit legado diverge do sales_limit_snapshot canonico';
  END IF;

  UPDATE public.billing_billable_sale_admissions a
  SET cycle_limit_snapshot = NULLIF(s.metadata->>'sales_limit_snapshot', '')::integer,
      usage_limit = NULLIF(s.metadata->>'sales_limit_snapshot', '')::integer,
      updated_at = now()
  FROM public.billing_subscriptions s
  WHERE s.id = a.subscription_id
    AND a.admission_result IN ('RESERVED', 'ADMITTED', 'RECOVERY_REQUIRED', 'PERSISTED')
    AND (a.cycle_limit_snapshot IS NULL OR a.cycle_limit_snapshot <= 0)
    AND NULLIF(s.metadata->>'sales_limit_snapshot', '')::integer > 0;

  SELECT COUNT(*) INTO v_legacy_limit
  FROM public.billing_billable_sale_admissions
  WHERE admission_result IN ('RESERVED', 'ADMITTED', 'RECOVERY_REQUIRED', 'PERSISTED')
    AND (cycle_limit_snapshot IS NULL OR cycle_limit_snapshot <= 0);

  IF v_legacy_limit > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: admissao legada sem cycle_limit_snapshot canonico (=%)', v_legacy_limit;
  END IF;
END $$;

-- 6.9A.10 — assinatura canônica Baby + quota_counting (NÃO altera PAID_PLAN)
DO $$
DECLARE
  v_ambiguous_users bigint;
  v_stale_fallback bigint;
  v_missing_quota bigint;
BEGIN
  -- Materializa quota_counting só para Baby com marco auditável (fallback_activated_at / trial_expired_at)
  UPDATE public.billing_subscriptions bs
  SET metadata = COALESCE(bs.metadata, '{}'::jsonb) || jsonb_build_object(
      'quota_counting_started_at', COALESCE(
        NULLIF(bs.metadata->>'quota_counting_started_at', ''),
        NULLIF(bs.metadata->>'fallback_activated_at', ''),
        NULLIF(bs.metadata->>'trial_expired_at', '')
      )
    ),
    updated_at = now()
  WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
    AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    AND COALESCE(bs.metadata->>'trial_state', '') NOT IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY')
    AND NULLIF(bs.metadata->>'quota_counting_started_at', '') IS NULL
    AND (
      NULLIF(bs.metadata->>'fallback_activated_at', '') IS NOT NULL
      OR NULLIF(bs.metadata->>'trial_expired_at', '') IS NOT NULL
    );

  -- Usuários com >1 assinatura Baby candidata (fallback ativo)
  SELECT COUNT(*) INTO v_ambiguous_users
  FROM (
    SELECT bs.user_id
    FROM public.billing_subscriptions bs
    WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
      AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    GROUP BY bs.user_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_ambiguous_users > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: manual_review_required assinatura_canonica_ambigua users=%', v_ambiguous_users;
  END IF;

  -- Fallbacks antigos órfãos: mais de um marcado ativo no mesmo user (já coberto) /
  -- ou Baby ativo sem ciclo/quota confiável
  SELECT COUNT(*) INTO v_missing_quota
  FROM public.billing_subscriptions bs
  WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
    AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    AND COALESCE(bs.metadata->>'trial_state', '') NOT IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY')
    AND (
      NULLIF(bs.metadata->>'quota_counting_started_at', '') IS NULL
      OR COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', '')) IS NULL
      OR NULLIF(bs.metadata->>'fallback_period_end', '') IS NULL
    );

  IF v_missing_quota > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: manual_review_required baby_sem_marco_ciclo_ou_quota (=%)', v_missing_quota;
  END IF;

  SELECT COUNT(*) INTO v_stale_fallback
  FROM public.billing_subscriptions bs
  WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
    AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    AND lower(COALESCE(bs.status, '')) IN ('canceled', 'cancelled', 'refunded', 'superseded');

  IF v_stale_fallback > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: manual_review_required fallback_ativo_em_assinatura_terminal (=%)', v_stale_fallback;
  END IF;
END $$;

-- Baseline 6.9A.10: PERSISTED na janela civil SP semiaberta ∩ pós quota
-- cycle_started_at <= official < cycle_ends_at_exclusive (America/Sao_Paulo)
DO $$
DECLARE
  v_backfilled bigint := 0;
  v_except_eligible bigint;
  v_except_admissions bigint;
  v_incomplete_active bigint;
  v_incomplete_sales bigint;
BEGIN
  IF to_regclass('public.sales_orders') IS NULL THEN
    RAISE EXCEPTION 'billing_admission_hardening: sales_orders ausente para baseline';
  END IF;
  IF to_regclass('public.marketplace_accounts') IS NULL THEN
    RAISE EXCEPTION 'billing_admission_hardening: marketplace_accounts ausente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_orders'
      AND column_name = 'date_created_marketplace'
  ) THEN
    RAISE EXCEPTION 'billing_admission_hardening: sales_orders.date_created_marketplace ausente';
  END IF;

  SELECT COUNT(*) INTO v_incomplete_active
  FROM public.billing_billable_sale_admissions a
  WHERE a.admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
    AND (
      a.marketplace IS NULL OR btrim(a.marketplace) = ''
      OR a.marketplace_account_id IS NULL
      OR a.external_order_id IS NULL OR btrim(a.external_order_id) = ''
      OR NOT EXISTS (
        SELECT 1 FROM public.marketplace_accounts ma
        WHERE ma.id = a.marketplace_account_id
          AND ma.user_id = a.user_id
          AND ma.marketplace = a.marketplace
      )
    );

  IF v_incomplete_active > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: manual_review_required active_incomplete_identity_admissions (=%)', v_incomplete_active;
  END IF;

  SELECT COUNT(*) INTO v_incomplete_sales
  FROM public.billing_subscriptions bs
  JOIN public.sales_orders so ON so.user_id = bs.user_id
  CROSS JOIN LATERAL public.billing_internal_resolve_baby_cycle_window(bs.metadata) w
  WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
    AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
    AND COALESCE((w->>'ok')::boolean, false)
    AND so.date_created_marketplace IS NOT NULL
    AND so.date_created_marketplace >= GREATEST(
      (bs.metadata->>'quota_counting_started_at')::timestamptz,
      (w->>'cycle_started_at')::timestamptz
    )
    AND so.date_created_marketplace < (w->>'cycle_ends_at_exclusive')::timestamptz
    AND (
      so.marketplace IS NULL OR btrim(so.marketplace) = ''
      OR so.marketplace_account_id IS NULL
      OR so.external_order_id IS NULL OR btrim(so.external_order_id) = ''
      OR NOT EXISTS (
        SELECT 1 FROM public.marketplace_accounts ma
        WHERE ma.id = so.marketplace_account_id
          AND ma.user_id = bs.user_id
          AND ma.marketplace = so.marketplace
      )
    );

  IF v_incomplete_sales > 0 THEN
    RAISE NOTICE 'billing_admission_hardening: incomplete_identity_in_cycle_window=% (nao backfill automatico)', v_incomplete_sales;
  END IF;

  INSERT INTO public.billing_billable_sale_admissions (
    user_id, subscription_id, cycle_key, external_order_id,
    marketplace, marketplace_account_id, admission_result,
    usage_count_after, usage_limit, cycle_limit_snapshot,
    entitlement_type, entitlement_source, idempotency_key,
    reservation_owner_token, reservation_attempt_id,
    persisted_at, finalized_at, updated_at, created_at
  )
  SELECT
    src.user_id,
    src.subscription_id,
    src.cycle_key,
    src.external_order_id,
    src.marketplace,
    src.marketplace_account_id,
    'PERSISTED',
    NULL,
    src.cycle_limit_snapshot,
    src.cycle_limit_snapshot,
    'BABY_INTERNAL_FREE',
    'current_cycle_eligible_backfill',
    'billable_sale:' || src.subscription_id::text || ':'
      || src.cycle_key || ':'
      || src.marketplace || ':'
      || src.marketplace_account_id::text || ':'
      || src.external_order_id,
    gen_random_uuid(),
    gen_random_uuid(),
    src.persisted_at,
    now(),
    now(),
    src.created_at
  FROM (
    SELECT DISTINCT ON (bs.id, so.marketplace, so.marketplace_account_id, so.external_order_id)
      bs.user_id,
      bs.id AS subscription_id,
      COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', '')) AS cycle_key,
      so.external_order_id,
      so.marketplace,
      so.marketplace_account_id,
      NULLIF(bs.metadata->>'sales_limit_snapshot', '')::integer AS cycle_limit_snapshot,
      so.date_created_marketplace AS persisted_at,
      COALESCE(so.created_at, now()) AS created_at
    FROM public.billing_subscriptions bs
    JOIN public.sales_orders so ON so.user_id = bs.user_id
    JOIN public.marketplace_accounts ma
      ON ma.id = so.marketplace_account_id
     AND ma.user_id = bs.user_id
     AND ma.marketplace = so.marketplace
    WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
      AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
      AND COALESCE(bs.metadata->>'trial_state', '') NOT IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY')
      AND NULLIF(bs.metadata->>'quota_counting_started_at', '') IS NOT NULL
      AND COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', '')) IS NOT NULL
      AND NULLIF(bs.metadata->>'fallback_period_end', '') IS NOT NULL
      AND NULLIF(bs.metadata->>'sales_limit_snapshot', '')::integer > 0
      -- assinatura canônica: exatamente 1 Baby fallback ativo por user (já abortado se >1)
      AND NOT EXISTS (
        SELECT 1 FROM public.billing_subscriptions other
        WHERE other.user_id = bs.user_id
          AND other.id <> bs.id
          AND COALESCE((other.metadata->>'suspension_fallback_active')::boolean, false)
          AND COALESCE(other.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
      )
      AND so.marketplace IS NOT NULL AND btrim(so.marketplace) <> ''
      AND so.marketplace_account_id IS NOT NULL
      AND so.external_order_id IS NOT NULL AND btrim(so.external_order_id) <> ''
      AND so.date_created_marketplace IS NOT NULL
      AND COALESCE((public.billing_internal_resolve_baby_cycle_window(bs.metadata)->>'ok')::boolean, false)
      AND so.date_created_marketplace >= GREATEST(
        (bs.metadata->>'quota_counting_started_at')::timestamptz,
        (public.billing_internal_resolve_baby_cycle_window(bs.metadata)->>'cycle_started_at')::timestamptz
      )
      AND so.date_created_marketplace < (
        public.billing_internal_resolve_baby_cycle_window(bs.metadata)->>'cycle_ends_at_exclusive'
      )::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM public.billing_billable_sale_admissions a
        WHERE a.subscription_id = bs.id
          AND a.cycle_key = COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', ''))
          AND a.marketplace = so.marketplace
          AND a.marketplace_account_id = so.marketplace_account_id
          AND a.external_order_id = so.external_order_id
          AND a.admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
      )
    ORDER BY bs.id, so.marketplace, so.marketplace_account_id, so.external_order_id, so.date_created_marketplace ASC NULLS LAST
  ) src;

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'billing_admission_hardening: current_cycle_eligible_backfill=%', v_backfilled;

  -- Identidade: eligible EXCEPT admissions = 0 AND reverse = 0
  WITH eligible_sales AS (
    SELECT DISTINCT
      bs.id AS subscription_id,
      COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', '')) AS cycle_key,
      so.marketplace,
      so.marketplace_account_id,
      so.external_order_id
    FROM public.billing_subscriptions bs
    JOIN public.sales_orders so ON so.user_id = bs.user_id
    JOIN public.marketplace_accounts ma
      ON ma.id = so.marketplace_account_id
     AND ma.user_id = bs.user_id
     AND ma.marketplace = so.marketplace
    CROSS JOIN LATERAL public.billing_internal_resolve_baby_cycle_window(bs.metadata) w
    WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
      AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
      AND COALESCE(bs.metadata->>'trial_state', '') NOT IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY')
      AND NULLIF(bs.metadata->>'quota_counting_started_at', '') IS NOT NULL
      AND COALESCE((w->>'ok')::boolean, false)
      AND so.marketplace IS NOT NULL AND btrim(so.marketplace) <> ''
      AND so.marketplace_account_id IS NOT NULL
      AND so.external_order_id IS NOT NULL AND btrim(so.external_order_id) <> ''
      AND so.date_created_marketplace IS NOT NULL
      AND so.date_created_marketplace >= GREATEST(
        (bs.metadata->>'quota_counting_started_at')::timestamptz,
        (w->>'cycle_started_at')::timestamptz
      )
      AND so.date_created_marketplace < (w->>'cycle_ends_at_exclusive')::timestamptz
  ),
  active_admissions AS (
    SELECT DISTINCT a.subscription_id, a.cycle_key, a.marketplace, a.marketplace_account_id, a.external_order_id
    FROM public.billing_billable_sale_admissions a
    JOIN public.billing_subscriptions bs ON bs.id = a.subscription_id
    WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
      AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
      AND a.admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
      AND a.cycle_key = COALESCE(NULLIF(bs.metadata->>'usage_limit_cycle_key', ''), NULLIF(bs.metadata->>'fallback_period_start', ''))
  )
  SELECT
    (SELECT COUNT(*) FROM (SELECT * FROM eligible_sales EXCEPT SELECT * FROM active_admissions) x),
    (SELECT COUNT(*) FROM (SELECT * FROM active_admissions EXCEPT SELECT * FROM eligible_sales) y)
  INTO v_except_eligible, v_except_admissions;

  IF v_except_eligible > 0 OR v_except_admissions > 0 THEN
    RAISE EXCEPTION 'billing_admission_hardening: identity_except_gap eligible_minus=% admissions_minus=%',
      v_except_eligible, v_except_admissions;
  END IF;
END $$;

DO $$
BEGIN
  DROP INDEX IF EXISTS public.plans_baby_active_uidx;
  CREATE UNIQUE INDEX plans_baby_active_uidx
    ON public.plans (plan_key)
    WHERE plan_key = 'baby' AND COALESCE(is_active, true);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'billing_admission_hardening: nao foi possivel criar plans_baby_active_uidx (Babys duplicados)';
END $$;

DROP INDEX IF EXISTS public.billing_billable_sale_admissions_cycle_idx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_active_order_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_idempotency_uidx;
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_recovery_idx;

CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_cycle_active_idx ON public.billing_billable_sale_admissions (subscription_id, cycle_key, admission_result);
CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_expires_idx ON public.billing_billable_sale_admissions (reservation_expires_at) WHERE admission_result = 'RESERVED';
CREATE INDEX IF NOT EXISTS billing_billable_sale_admissions_recovery_idx ON public.billing_billable_sale_admissions (next_recovery_at) WHERE admission_result = 'RECOVERY_REQUIRED';
CREATE UNIQUE INDEX billing_billable_sale_admissions_active_order_uidx ON public.billing_billable_sale_admissions (
  subscription_id, cycle_key, marketplace, marketplace_account_id, external_order_id
) WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')
  AND marketplace IS NOT NULL AND btrim(marketplace) <> ''
  AND marketplace_account_id IS NOT NULL
  AND external_order_id IS NOT NULL AND btrim(external_order_id) <> '';
CREATE UNIQUE INDEX billing_billable_sale_admissions_idempotency_uidx ON public.billing_billable_sale_admissions (subscription_id, cycle_key, idempotency_key) WHERE admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED');

DROP FUNCTION IF EXISTS public.billing_internal_read_plan_sales_limit_from_catalog(text);
DROP FUNCTION IF EXISTS public.billing_internal_materialize_open_cycle_sales_limit_snapshot(uuid);
DROP FUNCTION IF EXISTS public.billing_report_billable_sale_finalize_failure_v2(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.billing_internal_resolve_current_baby_cycle(uuid, uuid);
DROP FUNCTION IF EXISTS public.billing_internal_read_open_cycle_snapshot(uuid);
DROP FUNCTION IF EXISTS public.billing_internal_build_admission_idempotency_key(uuid, text, text, uuid, text);
DROP FUNCTION IF EXISTS public.billing_internal_sync_subscription_usage_count(uuid, text, jsonb, timestamptz);
DROP FUNCTION IF EXISTS public.billing_internal_expire_admission_row(uuid, text);
DROP FUNCTION IF EXISTS public.billing_internal_mark_recovery_required(uuid, text, text);
DROP FUNCTION IF EXISTS public.billing_internal_reconcile_admission_row(uuid);
DROP FUNCTION IF EXISTS public.billing_renew_billable_sale_reservation_lease_v2(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, text, uuid, integer, boolean);
DROP FUNCTION IF EXISTS public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean);
DROP FUNCTION IF EXISTS public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamptz, text);
DROP FUNCTION IF EXISTS public.billing_finalize_billable_sale_v2(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.billing_finalize_billable_sale_v2(uuid, uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.billing_release_billable_sale_v2(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.billing_release_billable_sale_v2(uuid, uuid, uuid, text);

`;

const rlsGuard = `
DO $$
DECLARE v_rls boolean;
BEGIN
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'billing_billable_sale_admissions';
  IF NOT COALESCE(v_rls, false) THEN RAISE EXCEPTION 'billing_admission_hardening: RLS nao habilitado'; END IF;
END $$;

`;

const baselineSync = `
-- Sincroniza usage_count e aplica ARCHIVE_READ_ONLY se baseline já está no limite
DO $$
DECLARE
  r record;
  v_cycle text;
  v_limit integer;
  v_count integer;
  v_meta jsonb;
BEGIN
  FOR r IN
    SELECT bs.id AS subscription_id, bs.metadata
    FROM public.billing_subscriptions bs
    WHERE COALESCE((bs.metadata->>'suspension_fallback_active')::boolean, false)
      AND COALESCE(bs.metadata->>'effective_entitlement', '') = 'BABY_INTERNAL_FREE'
      AND COALESCE(bs.metadata->>'trial_state', '') NOT IN ('ACTIVE', 'ENDING_SOON', 'ENDS_TODAY')
      AND NULLIF(bs.metadata->>'quota_counting_started_at', '') IS NOT NULL
  LOOP
    v_cycle := COALESCE(NULLIF(r.metadata->>'usage_limit_cycle_key', ''), NULLIF(r.metadata->>'fallback_period_start', ''));
    v_limit := NULLIF(r.metadata->>'sales_limit_snapshot', '')::integer;
    IF v_cycle IS NULL OR v_limit IS NULL OR v_limit <= 0 THEN
      CONTINUE;
    END IF;

    v_count := public.billing_count_active_billable_slots(r.subscription_id, v_cycle);
    v_meta := public.billing_internal_sync_subscription_usage_count(
      r.subscription_id,
      v_cycle,
      COALESCE(r.metadata, '{}'::jsonb),
      now()
    );

    IF v_count >= v_limit
       AND COALESCE(v_meta->>'sync_state', '') IS DISTINCT FROM 'HARD_PAUSED'
       AND COALESCE((public.billing_internal_resolve_access_precedence(v_meta)->>'precedence_rank')::integer, 99) >= 4 THEN
      v_meta := v_meta || jsonb_build_object(
        'previous_sync_state', COALESCE(v_meta->>'sync_state', 'FULL'),
        'previous_usage_state', COALESCE(v_meta->>'usage_state', 'OK'),
        'previous_access_profile', COALESCE(v_meta->>'access_profile', 'FULL_ACCESS'),
        'sync_state', 'HARD_PAUSED',
        'usage_state', 'HARD_LIMIT_REACHED',
        'access_profile', 'ARCHIVE_READ_ONLY',
        'hard_pause_cycle_key', v_cycle,
        'hard_pause_reason', 'BABY_LIMIT_REACHED',
        'hard_pause_owner', 'BABY_QUOTA_ENGINE',
        'hard_pause_source', 'MIGRATION_BASELINE',
        'hard_pause_started_at', now()
      );
    END IF;

    UPDATE public.billing_subscriptions
    SET metadata = v_meta, updated_at = now()
    WHERE id = r.subscription_id;
  END LOOP;
END $$;

`;

const output = preamble + functionsBlock + rlsGuard + baselineSync + revokeBlock;

// SSOT: bloco de funções da base deve estar intacto no forward
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const forwardFunctionsHash = hash(functionsBlock);
if (!output.includes(functionsBlock)) {
  console.error("[generate 6.9A.10] SSOT fail: funções base ≠ funções forward");
  process.exit(1);
}
if (!functionsBlock.includes("billing_internal_resolve_access_precedence")) {
  console.error("[generate 6.9A.10] SSOT fail: precedence helper ausente na base");
  process.exit(1);
}
if (!functionsBlock.includes("p_official_order_at")) {
  console.error("[generate 6.9A.10] SSOT fail: reserve sem p_official_order_at");
  process.exit(1);
}

let previousCommitted = null;
if (fs.existsSync(outPath)) {
  previousCommitted = fs.readFileSync(outPath, "utf8").replace(/\r\n/g, "\n");
}

fs.writeFileSync(outPath, output, "utf8");

if (previousCommitted != null && hash(previousCommitted) !== hash(output)) {
  console.log("[generate 6.9A.10] forward regenerado (divergia do commit anterior — esperado na 1ª geração)");
}

const stale = path.join(
  root,
  "supabase/migrations/20260723140000_s7_billing_billable_sale_admission_atomic_hardening_6_9a9.sql",
);
if (fs.existsSync(stale)) {
  fs.unlinkSync(stale);
  console.log("[generate 6.9A.10] removed stale 6_9a9 forward from deploy path");
}

console.log("[generate 6.9A.10 hardening] OK", {
  outPath,
  bytes: output.length,
  functions_sha256: forwardFunctionsHash.slice(0, 16),
});
