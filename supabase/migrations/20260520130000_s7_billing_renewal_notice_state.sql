-- =============================================================================
-- S7 BILLING FASE 2.1 — estado anti-spam de alertas de renovação
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.billing_renewal_notice_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  renewal_cycle_id uuid NOT NULL REFERENCES public.billing_renewal_cycles (id) ON DELETE CASCADE,
  last_popup_shown_at timestamptz,
  last_banner_dismissed_at timestamptz,
  last_alert_level_seen text,
  popup_shown_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_renewal_notice_state_popup_count_nonneg CHECK (popup_shown_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_renewal_notice_state_user_cycle_uidx
  ON public.billing_renewal_notice_state (user_id, renewal_cycle_id);

CREATE INDEX IF NOT EXISTS billing_renewal_notice_state_user_idx
  ON public.billing_renewal_notice_state (user_id);

COMMENT ON TABLE public.billing_renewal_notice_state IS
  'Anti-spam de banner/popup de renovação por seller e ciclo.';

ALTER TABLE public.billing_renewal_notice_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_renewal_notice_state_select_own ON public.billing_renewal_notice_state;
CREATE POLICY billing_renewal_notice_state_select_own ON public.billing_renewal_notice_state
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_renewal_notice_state_insert_own ON public.billing_renewal_notice_state;
CREATE POLICY billing_renewal_notice_state_insert_own ON public.billing_renewal_notice_state
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS billing_renewal_notice_state_update_own ON public.billing_renewal_notice_state;
CREATE POLICY billing_renewal_notice_state_update_own ON public.billing_renewal_notice_state
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
