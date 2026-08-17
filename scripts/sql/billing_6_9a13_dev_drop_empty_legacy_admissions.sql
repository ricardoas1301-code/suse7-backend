-- S1.HF.6.9A.13 — drop schema legado vazio (somente se count=0)
DO $$
DECLARE
  c bigint;
BEGIN
  SELECT COUNT(*) INTO c FROM public.billing_billable_sale_admissions;
  IF c <> 0 THEN
    RAISE EXCEPTION 'admissions not empty (%) — abort drop', c;
  END IF;
  DROP TABLE public.billing_billable_sale_admissions CASCADE;
  RAISE NOTICE 'dropped empty legacy billing_billable_sale_admissions';
END $$;
