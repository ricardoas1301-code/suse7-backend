-- =============================================================================
-- S7 — Central de Templates (Fase S5.4)
-- Formaliza/estende a tabela existente s7_notification_templates como a fonte
-- única de verdade de templates do Motor Central. NÃO cria tabela paralela.
--
-- Mudanças 100% aditivas:
--   1. version        → versão atual do template (controle de evolução)
--   2. status         → ciclo de vida (draft/active/deprecated/archived)
--   3. template_type  → tipo genérico (transactional/operational/system) — sem negócio
--   4. s7_notification_template_versions → histórico de versões + auditoria
--      (quem alterou, quando, qual versão)
--
-- Esta fase NÃO insere templates de negócio.
-- =============================================================================

-- 1 a 3. Colunas de versionamento / status / tipo (aditivas) -------------------
ALTER TABLE public.s7_notification_templates
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

ALTER TABLE public.s7_notification_templates
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE public.s7_notification_templates
  ADD COLUMN IF NOT EXISTS template_type TEXT;

ALTER TABLE public.s7_notification_templates
  DROP CONSTRAINT IF EXISTS s7_notification_templates_status_chk;
ALTER TABLE public.s7_notification_templates
  ADD CONSTRAINT s7_notification_templates_status_chk
  CHECK (status IN ('draft', 'active', 'deprecated', 'archived'));

COMMENT ON COLUMN public.s7_notification_templates.version IS
  'Versão atual do template (Central de Templates S5.4). Incrementada a cada alteração de conteúdo.';
COMMENT ON COLUMN public.s7_notification_templates.status IS
  'Ciclo de vida do template: draft | active | deprecated | archived.';
COMMENT ON COLUMN public.s7_notification_templates.template_type IS
  'Tipo genérico do template (ex.: transactional/operational/system). Sem regra de negócio.';

-- 4. Histórico de versões + auditoria -----------------------------------------
CREATE TABLE IF NOT EXISTS public.s7_notification_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID REFERENCES public.s7_notification_templates (id) ON DELETE SET NULL,
  template_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'pt-BR',
  version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  subject_template TEXT NOT NULL DEFAULT '',
  body_template TEXT NOT NULL DEFAULT '',
  variables_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Auditoria: quem / quando / o quê
  change_action TEXT NOT NULL DEFAULT 'created',
  changed_by UUID,
  changed_by_email TEXT,
  change_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT s7_notification_template_versions_status_chk
    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  CONSTRAINT s7_notification_template_versions_action_chk
    CHECK (change_action IN ('created', 'updated', 'status_changed', 'archived', 'restored')),
  CONSTRAINT s7_notification_template_versions_slot_version_uq
    UNIQUE (template_key, channel, locale, version)
);

CREATE INDEX IF NOT EXISTS s7_notification_template_versions_slot_idx
  ON public.s7_notification_template_versions (template_key, channel, locale, version DESC);

CREATE INDEX IF NOT EXISTS s7_notification_template_versions_template_idx
  ON public.s7_notification_template_versions (template_id, created_at DESC);

COMMENT ON TABLE public.s7_notification_template_versions IS
  'Histórico de versões e auditoria de alterações dos templates (Central de Templates S5.4): snapshot por versão + quem/quando/qual ação.';
