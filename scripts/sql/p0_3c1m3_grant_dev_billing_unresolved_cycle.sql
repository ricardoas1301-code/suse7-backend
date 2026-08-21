-- P0.3-C.1M3 — DEV grant pós-migration (verificar project-ref antes de executar)
-- Target esperado: alkelcaoexxbamqddaqv (Fresh DEV V2)

GRANT EXECUTE ON FUNCTION public.billing_upsert_manual_review_pending_v2(
  uuid, uuid, text, text, text, uuid, text, text, text, timestamptz, timestamptz
) TO service_role;

GRANT EXECUTE ON FUNCTION public.billing_resolve_pending_cycle_v1(
  uuid, uuid, text, text
) TO service_role;
