-- S1 Bloco 3 — feature flags operacionais por seller (Dev Center Toolbox)

CREATE TABLE IF NOT EXISTS public.dev_center_seller_feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL,
  flag_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'seller',
  marketplace text NULL,
  plan_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dev_center_seller_feature_flags_scope_chk
    CHECK (scope IN ('seller', 'plan', 'system', 'marketplace', 'rollout', 'temporary', 'beta')),
  CONSTRAINT dev_center_seller_feature_flags_unique_seller_key UNIQUE (seller_id, flag_key)
);

CREATE INDEX IF NOT EXISTS dev_center_seller_feature_flags_seller_idx
  ON public.dev_center_seller_feature_flags (seller_id, updated_at DESC);

COMMENT ON TABLE public.dev_center_seller_feature_flags IS
  'Overrides operacionais de feature flags por seller (Dev Center Toolbox).';
