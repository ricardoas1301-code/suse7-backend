-- P0.3-C.1M2 — DEV grant pós-migration (target: alkelcaoexxbamqddaqv)

GRANT EXECUTE ON FUNCTION public.billing_promote_manual_review_pending_to_reservation_v1(
  uuid, uuid, uuid, integer, boolean
) TO service_role;

GRANT EXECUTE ON FUNCTION public.billing_finalize_manual_review_not_billable_v1(
  uuid, uuid, text
) TO service_role;
