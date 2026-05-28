-- S1 Bloco 4 — auditoria estruturada (before/after, entidade, categoria, timeline)

ALTER TABLE public.dev_center_toolbox_operational_audit
  ADD COLUMN IF NOT EXISTS before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS entity_type text NULL,
  ADD COLUMN IF NOT EXISTS entity_id text NULL,
  ADD COLUMN IF NOT EXISTS category text NULL;

CREATE INDEX IF NOT EXISTS dev_center_toolbox_operational_audit_category_idx
  ON public.dev_center_toolbox_operational_audit (seller_id, category, created_at DESC)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS dev_center_toolbox_operational_audit_entity_idx
  ON public.dev_center_toolbox_operational_audit (entity_type, entity_id, created_at DESC)
  WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;

COMMENT ON COLUMN public.dev_center_toolbox_operational_audit.before_state IS
  'Snapshot operacional antes da ação administrativa.';
COMMENT ON COLUMN public.dev_center_toolbox_operational_audit.after_state IS
  'Snapshot operacional após a ação administrativa.';
COMMENT ON COLUMN public.dev_center_toolbox_operational_audit.changed_fields IS
  'Lista JSON de campos alterados entre before_state e after_state.';
