-- Canonical: legal_document_acceptances
-- Origem: scripts/migrations/20260812_legal_document_acceptances.sql (repo root)
-- Posição: após s7_primary_company_default_recipient (20260812120000)

CREATE TABLE IF NOT EXISTS public.legal_document_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  document_type text NOT NULL,
  document_version text NOT NULL,
  document_hash text NOT NULL,
  accepted_at timestamptz NOT NULL,
  source text NOT NULL,
  scrolled_to_end boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_document_acceptances_document_type_chk
    CHECK (char_length(trim(document_type)) > 0),
  CONSTRAINT legal_document_acceptances_document_version_chk
    CHECK (char_length(trim(document_version)) > 0),
  CONSTRAINT legal_document_acceptances_document_hash_chk
    CHECK (char_length(trim(document_hash)) = 64),
  CONSTRAINT legal_document_acceptances_source_chk
    CHECK (char_length(trim(source)) > 0),
  CONSTRAINT legal_document_acceptances_scrolled_to_end_chk
    CHECK (scrolled_to_end = true)
);

CREATE INDEX IF NOT EXISTS legal_document_acceptances_user_id_idx
  ON public.legal_document_acceptances (user_id);

CREATE INDEX IF NOT EXISTS legal_document_acceptances_user_doc_idx
  ON public.legal_document_acceptances (user_id, document_type, accepted_at DESC);

ALTER TABLE public.legal_document_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_document_acceptances_select_own ON public.legal_document_acceptances;
CREATE POLICY legal_document_acceptances_select_own
  ON public.legal_document_acceptances FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS legal_document_acceptances_insert_own ON public.legal_document_acceptances;
CREATE POLICY legal_document_acceptances_insert_own
  ON public.legal_document_acceptances FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.legal_document_acceptances IS
  'Aceites expressos de documentos legais (ex.: Termos de Uso), com versão e hash do conteúdo apresentado.';
