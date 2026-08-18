-- =====================================================================
-- Dev Center interno — missões, handoff (Rico / Neo / Pedro), decisões
-- Acesso via backend (service role) + allowlist de e-mail em env.
-- RLS ativo sem policies = sem acesso direto pelo PostgREST (JWT).
-- Próximo arquivo obrigatório: 20260403120000_dev_center_v2_status_exec_history.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.dev_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'blocked', 'done', 'archived')),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  module text,
  summary text,
  next_steps text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.dev_conversation_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES public.dev_missions (id) ON DELETE CASCADE,
  rico_text text,
  neo_text text,
  pedro_text text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dev_conversation_contexts_mission_unique UNIQUE (mission_id)
);

CREATE TABLE IF NOT EXISTS public.dev_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES public.dev_missions (id) ON DELETE CASCADE,
  decision_text text NOT NULL DEFAULT '',
  reason text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_decisions_mission_id ON public.dev_decisions (mission_id);
CREATE INDEX IF NOT EXISTS idx_dev_missions_updated_at ON public.dev_missions (updated_at DESC);

CREATE OR REPLACE FUNCTION public.set_dev_missions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dev_missions_updated_at ON public.dev_missions;
CREATE TRIGGER trg_dev_missions_updated_at
  BEFORE UPDATE ON public.dev_missions
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_dev_missions_updated_at();

CREATE OR REPLACE FUNCTION public.touch_dev_mission_from_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.dev_missions SET updated_at = now() WHERE id = NEW.mission_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dev_context_touch_mission ON public.dev_conversation_contexts;
CREATE TRIGGER trg_dev_context_touch_mission
  AFTER INSERT OR UPDATE ON public.dev_conversation_contexts
  FOR EACH ROW
  EXECUTE PROCEDURE public.touch_dev_mission_from_context();

CREATE OR REPLACE FUNCTION public.touch_dev_mission_from_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    mid := OLD.mission_id;
  ELSE
    mid := NEW.mission_id;
  END IF;
  UPDATE public.dev_missions SET updated_at = now() WHERE id = mid;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_dev_decision_touch_mission ON public.dev_decisions;
CREATE TRIGGER trg_dev_decision_touch_mission
  AFTER INSERT OR UPDATE OR DELETE ON public.dev_decisions
  FOR EACH ROW
  EXECUTE PROCEDURE public.touch_dev_mission_from_decision();

ALTER TABLE public.dev_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dev_conversation_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dev_decisions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.dev_missions IS 'Missões do Dev Center (Suse7 interno).';
COMMENT ON TABLE public.dev_conversation_contexts IS 'Handoff estruturado Rico / Neo / Pedro por missão.';
COMMENT ON TABLE public.dev_decisions IS 'Decisões registradas por missão (evolução futura: IA / histórico).';
