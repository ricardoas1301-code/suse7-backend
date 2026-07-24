-- ======================================================================
-- S1.HF.6.9A.10 — GRANT DEV ONLY (SQL Editor autocontido — sessão única)
--
-- Substituir placeholders antes de homologar:
--   __S7_DEV_SUPABASE_PROJECT_REF__
--   __S7_DEV_ENV_FINGERPRINT__
--   __S7_DEV_OPERATOR_CONFIRM__  → YES_DEV_ONLY
--
-- Recomputa fingerprint canônico a partir do project_ref persistido
-- antes de conceder EXECUTE.
-- Pré-requisito: seed billing_internal_deployment_identity (6_9a10).
-- Pós-grant: scripts/sql/billing_admission_atomic_postgrant_dev_6_9a10.sql
-- PARADA: não executar em PROD nesta entrega de artefatos.
-- ======================================================================

BEGIN;

DO $$
DECLARE
  v_expected_environment constant text := 'DEV';
  v_expected_project_ref constant text := '__S7_DEV_SUPABASE_PROJECT_REF__';
  v_expected_fingerprint constant text := '__S7_DEV_ENV_FINGERPRINT__';
  v_expected_confirm constant text := '__S7_DEV_OPERATOR_CONFIRM__';

  v_db_environment text;
  v_db_project_ref text;
  v_db_fingerprint text;
  v_recomputed_fingerprint text;
BEGIN
  IF v_expected_project_ref LIKE '__S7_%'
     OR v_expected_fingerprint LIKE '__S7_%'
     OR v_expected_confirm LIKE '__S7_%' THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: placeholders __S7_* ainda nao configurados';
  END IF;

  IF btrim(v_expected_project_ref) = '' THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: project_ref vazio rejeitado';
  END IF;

  IF v_expected_confirm IS DISTINCT FROM 'YES_DEV_ONLY' THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: confirmacao explicita ausente (YES_DEV_ONLY)';
  END IF;

  SELECT environment, project_ref, env_fingerprint
  INTO v_db_environment, v_db_project_ref, v_db_fingerprint
  FROM public.billing_internal_deployment_identity
  WHERE id = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: billing_internal_deployment_identity ausente (seed DEV obrigatorio)';
  END IF;

  IF upper(v_db_environment) <> v_expected_environment THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: ambiente canonico nao e DEV (=%)', v_db_environment;
  END IF;

  IF lower(btrim(v_db_project_ref)) = '' THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: project_ref persistido vazio';
  END IF;

  IF lower(btrim(v_db_project_ref)) <> lower(btrim(v_expected_project_ref)) THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: project_ref divergente (banco %, script %)',
      v_db_project_ref, v_expected_project_ref;
  END IF;

  -- Fingerprint canônico recomputado do project_ref persistido (não confiar só no placeholder)
  v_recomputed_fingerprint := encode(
    digest(
      'S7|billing_deployment_identity|v1|environment=DEV|project_ref='
        || lower(btrim(v_db_project_ref)),
      'sha256'
    ),
    'hex'
  );

  IF lower(btrim(v_db_fingerprint)) <> v_recomputed_fingerprint THEN
    RAISE EXCEPTION
      'billing_admission_grant_dev: fingerprint persistido diverge do recomputado (banco %, recomputado %)',
      v_db_fingerprint, v_recomputed_fingerprint;
  END IF;

  IF lower(btrim(v_expected_fingerprint)) <> v_recomputed_fingerprint THEN
    RAISE EXCEPTION
      'billing_admission_grant_dev: fingerprint do script diverge do recomputado (script %, recomputado %)',
      v_expected_fingerprint, v_recomputed_fingerprint;
  END IF;

  RAISE NOTICE 'billing_admission_grant_dev_v9: identidade DEV validada project_ref=% fingerprint=%',
    v_db_project_ref, v_recomputed_fingerprint;
END $$;

GRANT EXECUTE ON FUNCTION public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_finalize_billable_sale_v2(uuid, uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_release_billable_sale_v2(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_reconcile_expired_billable_sale_reservations_v1(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_renew_billable_sale_reservation_lease_v2(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_report_billable_sale_finalize_failure_v2(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_count_admitted_billable_sales(uuid, text) TO service_role;

COMMIT;
