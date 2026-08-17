-- S1.HF.6.9A.13 — GRANT DEV ONLY (placeholders preenchidos)
-- project_ref=ujznkyvgqhxagemdgmor | confirm=YES_DEV_ONLY

BEGIN;

DO $$
DECLARE
  v_expected_environment constant text := 'DEV';
  v_expected_project_ref constant text := 'ujznkyvgqhxagemdgmor';
  v_expected_fingerprint constant text := 'ddc5da64a818940e7476db0b320bc04e06afa0f4e300c63d1f175dcbc3e6558b';
  v_expected_confirm constant text := 'YES_DEV_ONLY';

  v_db_environment text;
  v_db_project_ref text;
  v_db_fingerprint text;
  v_recomputed_fingerprint text;
BEGIN
  IF v_expected_confirm IS DISTINCT FROM 'YES_DEV_ONLY' THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: confirmacao explicita ausente (YES_DEV_ONLY)';
  END IF;

  SELECT environment, project_ref, env_fingerprint
  INTO v_db_environment, v_db_project_ref, v_db_fingerprint
  FROM public.billing_internal_deployment_identity
  WHERE id = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: billing_internal_deployment_identity ausente';
  END IF;

  IF upper(v_db_environment) <> v_expected_environment THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: ambiente canonico nao e DEV (=% )', v_db_environment;
  END IF;

  IF lower(btrim(v_db_project_ref)) <> lower(btrim(v_expected_project_ref)) THEN
    RAISE EXCEPTION 'billing_admission_grant_dev: project_ref divergente (banco %, script %)',
      v_db_project_ref, v_expected_project_ref;
  END IF;

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
      'billing_admission_grant_dev: fingerprint persistido diverge (banco %, recomputado %)',
      v_db_fingerprint, v_recomputed_fingerprint;
  END IF;

  IF lower(btrim(v_expected_fingerprint)) <> v_recomputed_fingerprint THEN
    RAISE EXCEPTION
      'billing_admission_grant_dev: fingerprint do script diverge (script %, recomputado %)',
      v_expected_fingerprint, v_recomputed_fingerprint;
  END IF;

  RAISE NOTICE 'billing_admission_grant_dev_6_9a13: identidade DEV OK project_ref=%', v_db_project_ref;
END $$;

GRANT EXECUTE ON FUNCTION public.billing_reserve_billable_sale_v2(uuid, uuid, text, text, uuid, text, uuid, integer, boolean, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_finalize_billable_sale_v2(uuid, uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_release_billable_sale_v2(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_reconcile_expired_billable_sale_reservations_v1(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_renew_billable_sale_reservation_lease_v2(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_report_billable_sale_finalize_failure_v2(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_count_admitted_billable_sales(uuid, text) TO service_role;

COMMIT;
