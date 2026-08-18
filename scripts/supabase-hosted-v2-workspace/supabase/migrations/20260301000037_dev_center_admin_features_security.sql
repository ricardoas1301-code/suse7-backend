-- =====================================================================
-- Dev Center — Features Globais + Segurança Administrativa Global
-- Fases S1_4 (Gestão de Features Globais) e S1_5 (Segurança Admin).
--
-- Escopo:
--   1) Catálogo global de features (persistido, não-hardcoded na UI).
--   2) Vínculo feature × escopo (preparado para Global/Plano/Seller/Conta).
--   3) Expansão da auditoria administrativa global (operação + crítico).
--
-- NÃO altera billing, vendas, produtos, anúncios, precificação ou regras
-- de produto. NÃO implementa RBAC nem rollout completos — apenas a base.
-- Acesso somente via backend (service role) + guard do Dev Center.
--
-- Migration ADITIVA e idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Catálogo global de features (S1_4.1)
--    status      → feature flag global (ativa/inativa) — S1_4.3/S1_4.4
--    rollout_stage → preparação de rollout futuro (S1_4.5)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key text NOT NULL UNIQUE,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'geral',
  status text NOT NULL DEFAULT 'ativa',
  rollout_stage text NOT NULL DEFAULT 'ga',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devcenter_features_status_check') THEN
    ALTER TABLE public.devcenter_features
      ADD CONSTRAINT devcenter_features_status_check
      CHECK (status IN ('ativa', 'inativa'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devcenter_features_rollout_check') THEN
    ALTER TABLE public.devcenter_features
      ADD CONSTRAINT devcenter_features_rollout_check
      CHECK (rollout_stage IN ('ga', 'beta', 'interno', 'experimental'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_devcenter_features_sort
  ON public.devcenter_features (sort_order, label);

ALTER TABLE public.devcenter_features ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.devcenter_features IS 'Catálogo global de features liberáveis do Suse7 (Dev Center). Acesso via backend.';
COMMENT ON COLUMN public.devcenter_features.status IS 'Feature flag global: ativa/inativa.';
COMMENT ON COLUMN public.devcenter_features.rollout_stage IS 'Preparação de rollout: ga/beta/interno/experimental.';

-- ---------------------------------------------------------------------
-- 2) Vínculo feature × escopo (S1_4.2)
--    Preparado para Global/Plano/Seller/Conta Marketplace.
--    Nesta fase usamos scope='plan' (e o status global vive na feature).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.devcenter_feature_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES public.devcenter_features (id) ON DELETE CASCADE,
  scope text NOT NULL,
  scope_id text,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devcenter_feature_assignments_scope_check') THEN
    ALTER TABLE public.devcenter_feature_assignments
      ADD CONSTRAINT devcenter_feature_assignments_scope_check
      CHECK (scope IN ('global', 'plan', 'seller', 'marketplace_account'));
  END IF;
END $$;

-- Unicidade por (feature, escopo, alvo) — coalesce trata global (scope_id null).
CREATE UNIQUE INDEX IF NOT EXISTS uq_devcenter_feature_assignment
  ON public.devcenter_feature_assignments (feature_id, scope, COALESCE(scope_id, ''));
CREATE INDEX IF NOT EXISTS idx_devcenter_feature_assignment_scope
  ON public.devcenter_feature_assignments (scope, scope_id);

ALTER TABLE public.devcenter_feature_assignments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.devcenter_feature_assignments IS 'Vínculo feature × escopo (global/plan/seller/marketplace_account). Acesso via backend.';
COMMENT ON COLUMN public.devcenter_feature_assignments.scope_id IS 'Alvo do escopo (ex.: plan_id). NULL para global.';

-- ---------------------------------------------------------------------
-- 3) Expansão da auditoria administrativa global (S1_5.1 / S1_5.4)
--    operation_type → operação executada
--    is_critical    → classificação de operação crítica
-- ---------------------------------------------------------------------
ALTER TABLE public.devcenter_admin_audit
  ADD COLUMN IF NOT EXISTS operation_type text,
  ADD COLUMN IF NOT EXISTS is_critical boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_devcenter_admin_audit_critical
  ON public.devcenter_admin_audit (is_critical, created_at DESC);

COMMENT ON COLUMN public.devcenter_admin_audit.operation_type IS 'Operação executada (ex.: feature_created, feature_status_changed, plan_updated).';
COMMENT ON COLUMN public.devcenter_admin_audit.is_critical IS 'Marca operações administrativas críticas (S1_5.4).';

-- ---------------------------------------------------------------------
-- 4) Seed do catálogo global (idempotente — não sobrescreve edições).
-- ---------------------------------------------------------------------
INSERT INTO public.devcenter_features (feature_key, label, description, category, status, rollout_stage, sort_order)
VALUES
  ('ml_integration',        'Integrar Mercado Livre',   'Conexão e sincronização com o Mercado Livre.',        'integracao',    'ativa', 'ga',   10),
  ('executive_dashboard',   'Dashboard Executivo',      'Painel executivo com indicadores do negócio.',        'analytics',     'ativa', 'ga',   20),
  ('smart_pricing',         'Precificação Inteligente', 'Recomendações inteligentes de precificação.',         'pricing',       'ativa', 'ga',   30),
  ('freight_monitoring',    'Monitoramento de Frete',   'Acompanhamento de custos e prazos de frete.',         'logistica',     'ativa', 'ga',   40),
  ('whatsapp_notifications','Notificações WhatsApp',    'Alertas operacionais e avisos via WhatsApp.',         'notifications', 'ativa', 'ga',   50),
  ('customers_360',         'Clientes 360',             'Visão unificada de clientes do ecossistema.',         'crm',           'ativa', 'ga',   60),
  ('central_sync',          'Central Sync',             'Orquestração central de sincronizações.',             'sync',          'ativa', 'ga',   70),
  ('dev_center',            'Dev Center',               'Centro de governança e operação interna do Suse7.',   'sistema',       'ativa', 'interno', 80),
  ('future_resources',      'Recursos futuros',         'Espaço reservado para recursos em planejamento.',     'futuro',        'inativa', 'experimental', 90)
ON CONFLICT (feature_key) DO NOTHING;
