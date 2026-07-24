-- ======================================================================
-- S1.HF.6.9A.10 — SEED identidade DEV (artefato de auditoria)
-- Rejeita vazios: project_ref, audit_description, created_by.
-- PARADA: não executar em DEV/PROD até homologação explícita.
-- ======================================================================

SELECT
  'fingerprint_preview' AS check_id,
  lower(btrim('__S7_DEV_SUPABASE_PROJECT_REF__')) AS project_ref_normalizado,
  encode(
    digest(
      'S7|billing_deployment_identity|v1|environment=DEV|project_ref='
        || lower(btrim('__S7_DEV_SUPABASE_PROJECT_REF__')),
      'sha256'
    ),
    'hex'
  ) AS computed_env_fingerprint,
  '__S7_DEV_ENV_FINGERPRINT__' AS placeholder_fingerprint_informado,
  encode(
    digest(
      'S7|billing_deployment_identity|v1|environment=DEV|project_ref='
        || lower(btrim('__S7_DEV_SUPABASE_PROJECT_REF__')),
      'sha256'
    ),
    'hex'
  ) = lower(btrim('__S7_DEV_ENV_FINGERPRINT__')) AS placeholder_matches_canonical_formula;

BEGIN;

DO $$
DECLARE
  v_expected_environment constant text := '__S7_DEV_ENVIRONMENT__';
  v_expected_project_ref constant text := '__S7_DEV_SUPABASE_PROJECT_REF__';
  v_expected_fingerprint constant text := '__S7_DEV_ENV_FINGERPRINT__';
  v_audit_description constant text := '__S7_DEV_IDENTITY_AUDIT_DESCRIPTION__';
  v_created_by constant text := '__S7_DEV_IDENTITY_CREATED_BY__';

  v_norm_environment text;
  v_norm_project_ref text;
  v_norm_fingerprint text;
  v_computed_fingerprint text;

  v_existing_environment text;
  v_existing_project_ref text;
  v_existing_fingerprint text;
  v_existing_audit text;
  v_existing_created_by text;
  v_seeded_at timestamptz := now();
BEGIN
  IF v_expected_environment LIKE '__S7_%'
     OR v_expected_project_ref LIKE '__S7_%'
     OR v_expected_fingerprint LIKE '__S7_%'
     OR v_audit_description LIKE '__S7_%'
     OR v_created_by LIKE '__S7_%' THEN
    RAISE EXCEPTION 'billing_identity_seed: placeholders __S7_* ainda nao configurados';
  END IF;

  v_norm_environment := upper(btrim(v_expected_environment));
  v_norm_project_ref := lower(btrim(v_expected_project_ref));
  v_norm_fingerprint := lower(btrim(v_expected_fingerprint));

  IF v_norm_project_ref = '' THEN
    RAISE EXCEPTION 'billing_identity_seed: project_ref vazio rejeitado';
  END IF;
  IF btrim(v_audit_description) = '' THEN
    RAISE EXCEPTION 'billing_identity_seed: audit_description vazio rejeitado';
  END IF;
  IF btrim(v_created_by) = '' THEN
    RAISE EXCEPTION 'billing_identity_seed: created_by vazio rejeitado';
  END IF;

  IF v_norm_environment <> 'DEV' THEN
    RAISE EXCEPTION 'billing_identity_seed: environment proibido (=%) — apenas DEV', v_norm_environment;
  END IF;

  v_computed_fingerprint := encode(
    digest(
      'S7|billing_deployment_identity|v1|environment=DEV|project_ref=' || v_norm_project_ref,
      'sha256'
    ),
    'hex'
  );

  IF v_norm_fingerprint <> v_computed_fingerprint THEN
    RAISE EXCEPTION
      'billing_identity_seed: fingerprint diverge da formula canonica (informado %, esperado %)',
      v_norm_fingerprint,
      v_computed_fingerprint;
  END IF;

  IF to_regclass('public.billing_internal_deployment_identity') IS NULL THEN
    RAISE EXCEPTION 'billing_identity_seed: tabela billing_internal_deployment_identity ausente';
  END IF;

  SELECT environment, project_ref, env_fingerprint, audit_description, created_by
  INTO v_existing_environment, v_existing_project_ref, v_existing_fingerprint, v_existing_audit, v_existing_created_by
  FROM public.billing_internal_deployment_identity
  WHERE id = 1;

  IF FOUND THEN
    IF upper(btrim(v_existing_environment)) <> v_norm_environment
       OR lower(btrim(v_existing_project_ref)) <> v_norm_project_ref
       OR lower(btrim(v_existing_fingerprint)) <> v_norm_fingerprint
       OR btrim(v_existing_audit) <> btrim(v_audit_description)
       OR btrim(v_existing_created_by) <> btrim(v_created_by) THEN
      RAISE EXCEPTION
        'billing_identity_seed: identidade divergente ja existente — abortado sem UPDATE';
    END IF;

    RAISE NOTICE 'billing_identity_seed: idempotente — identidade DEV ja coincide';
    RETURN;
  END IF;

  INSERT INTO public.billing_internal_deployment_identity (
    id,
    environment,
    project_ref,
    env_fingerprint,
    audit_description,
    created_by,
    created_at,
    updated_at
  ) VALUES (
    1,
    v_norm_environment,
    v_norm_project_ref,
    v_norm_fingerprint,
    btrim(v_audit_description),
    btrim(v_created_by),
    v_seeded_at,
    v_seeded_at
  );

  RAISE NOTICE 'billing_identity_seed: inserido DEV audit=% created_by=%', v_audit_description, v_created_by;
END $$;

COMMIT;

SELECT
  'deployment_identity_row' AS check_id,
  id, environment, project_ref, env_fingerprint,
  audit_description, created_by, created_at, updated_at
FROM public.billing_internal_deployment_identity
WHERE id = 1;
