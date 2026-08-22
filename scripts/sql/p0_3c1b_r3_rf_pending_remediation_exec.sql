-- P0.3-C.1B-R3 RF remediation (generated 2026-08-22T16:05:47.993Z)
BEGIN;

DO $$
DECLARE
  v_count integer;
  v_updated integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM billing_billable_sale_admissions
  WHERE id IN ('c2ed2586-6608-4ebb-b1e5-b1bbc27ad81f','17802411-c323-407e-ab8d-159a0ea740b7','c820b2b3-9bc7-45dc-847b-16dd3a8512e4','a843c92e-b669-4ae9-90e1-d117a33c2622','c3569727-e926-47f7-956c-9b1bb0936417','3302438b-72ca-47ab-a43a-fb9e6cf824b1','058edc71-4dbd-4fb8-8167-8160dc9dc94b','7394ea7a-28da-42ad-bb74-f3e6713f7ae8','3c94b4f2-c025-4ac4-a1c0-127b2cedbc59')
    AND admission_result = 'PENDING_MANUAL_REVIEW'
    AND cycle_key LIKE 'p0_3c1b-t20-%';

  IF v_count <> 9 THEN
    RAISE EXCEPTION 'p0_3c1b_r3: expected 9 candidates, got %', v_count;
  END IF;

  UPDATE billing_billable_sale_admissions a
  SET cycle_key = NULL,
      idempotency_key = public.billing_internal_build_pending_manual_review_idempotency_key(
        a.subscription_id, a.marketplace, a.marketplace_account_id, a.external_order_id
      ),
      pending_cycle_resolved_at = NULL,
      pending_cycle_resolution_reason = NULL,
      updated_at = now()
  WHERE a.id IN ('c2ed2586-6608-4ebb-b1e5-b1bbc27ad81f','17802411-c323-407e-ab8d-159a0ea740b7','c820b2b3-9bc7-45dc-847b-16dd3a8512e4','a843c92e-b669-4ae9-90e1-d117a33c2622','c3569727-e926-47f7-956c-9b1bb0936417','3302438b-72ca-47ab-a43a-fb9e6cf824b1','058edc71-4dbd-4fb8-8167-8160dc9dc94b','7394ea7a-28da-42ad-bb74-f3e6713f7ae8','3c94b4f2-c025-4ac4-a1c0-127b2cedbc59')
    AND a.admission_result = 'PENDING_MANUAL_REVIEW'
    AND a.cycle_key LIKE 'p0_3c1b-t20-%';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 9 THEN
    RAISE EXCEPTION 'p0_3c1b_r3: updated % rows, expected 9', v_updated;
  END IF;
END $$;

COMMIT;
