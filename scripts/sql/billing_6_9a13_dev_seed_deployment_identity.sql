-- S1.HF.6.9A.13 — seed identidade DEV (Suse7-dev)
-- project_ref: ujznkyvgqhxagemdgmor
-- fingerprint: sha256(S7|billing_deployment_identity|v1|environment=DEV|project_ref=ujznkyvgqhxagemdgmor)

BEGIN;

INSERT INTO public.billing_internal_deployment_identity (
  id, environment, project_ref, env_fingerprint, audit_description, created_by
)
VALUES (
  1,
  'DEV',
  'ujznkyvgqhxagemdgmor',
  'ddc5da64a818940e7476db0b320bc04e06afa0f4e300c63d1f175dcbc3e6558b',
  'S1.HF.6.9A.13 integrated DEV activation',
  'simao_6_9a13'
)
ON CONFLICT (id) DO UPDATE
SET
  environment = EXCLUDED.environment,
  project_ref = EXCLUDED.project_ref,
  env_fingerprint = EXCLUDED.env_fingerprint,
  audit_description = EXCLUDED.audit_description,
  created_by = EXCLUDED.created_by;

COMMIT;
