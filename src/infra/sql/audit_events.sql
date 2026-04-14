-- ======================================================================
-- SUSE7 — Tabela audit_events
-- Auditoria de alterações em entidades (produtos, etc.)
-- ======================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update')),
  diff_json jsonb NOT NULL,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Índices para consultas comuns
CREATE INDEX IF NOT EXISTS idx_audit_events_user_id ON audit_events (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_trace_id ON audit_events (trace_id) WHERE trace_id IS NOT NULL;
