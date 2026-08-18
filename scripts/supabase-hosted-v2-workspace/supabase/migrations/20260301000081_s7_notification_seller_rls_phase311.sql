-- =============================================================================
-- Fase 3.1.1 — RLS seller para preferências e destinatários
-- =============================================================================

ALTER TABLE public.s7_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s7_notification_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.s7_notification_recipient_scopes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS s7_notification_preferences_seller_select ON public.s7_notification_preferences;
DROP POLICY IF EXISTS s7_notification_preferences_seller_insert ON public.s7_notification_preferences;
DROP POLICY IF EXISTS s7_notification_preferences_seller_update ON public.s7_notification_preferences;
DROP POLICY IF EXISTS s7_notification_preferences_seller_delete ON public.s7_notification_preferences;

CREATE POLICY s7_notification_preferences_seller_select
  ON public.s7_notification_preferences FOR SELECT
  TO authenticated
  USING (seller_id = auth.uid());

CREATE POLICY s7_notification_preferences_seller_insert
  ON public.s7_notification_preferences FOR INSERT
  TO authenticated
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY s7_notification_preferences_seller_update
  ON public.s7_notification_preferences FOR UPDATE
  TO authenticated
  USING (seller_id = auth.uid())
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY s7_notification_preferences_seller_delete
  ON public.s7_notification_preferences FOR DELETE
  TO authenticated
  USING (seller_id = auth.uid());

DROP POLICY IF EXISTS s7_notification_recipients_seller_select ON public.s7_notification_recipients;
DROP POLICY IF EXISTS s7_notification_recipients_seller_insert ON public.s7_notification_recipients;
DROP POLICY IF EXISTS s7_notification_recipients_seller_update ON public.s7_notification_recipients;
DROP POLICY IF EXISTS s7_notification_recipients_seller_delete ON public.s7_notification_recipients;

CREATE POLICY s7_notification_recipients_seller_select
  ON public.s7_notification_recipients FOR SELECT
  TO authenticated
  USING (seller_id = auth.uid());

CREATE POLICY s7_notification_recipients_seller_insert
  ON public.s7_notification_recipients FOR INSERT
  TO authenticated
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY s7_notification_recipients_seller_update
  ON public.s7_notification_recipients FOR UPDATE
  TO authenticated
  USING (seller_id = auth.uid())
  WITH CHECK (seller_id = auth.uid());

CREATE POLICY s7_notification_recipients_seller_delete
  ON public.s7_notification_recipients FOR DELETE
  TO authenticated
  USING (seller_id = auth.uid());

DROP POLICY IF EXISTS s7_notification_recipient_scopes_seller_select ON public.s7_notification_recipient_scopes;
DROP POLICY IF EXISTS s7_notification_recipient_scopes_seller_insert ON public.s7_notification_recipient_scopes;
DROP POLICY IF EXISTS s7_notification_recipient_scopes_seller_update ON public.s7_notification_recipient_scopes;
DROP POLICY IF EXISTS s7_notification_recipient_scopes_seller_delete ON public.s7_notification_recipient_scopes;

CREATE POLICY s7_notification_recipient_scopes_seller_select
  ON public.s7_notification_recipient_scopes FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.s7_notification_recipients r
      WHERE r.id = recipient_id AND r.seller_id = auth.uid()
    )
  );

CREATE POLICY s7_notification_recipient_scopes_seller_insert
  ON public.s7_notification_recipient_scopes FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.s7_notification_recipients r
      WHERE r.id = recipient_id AND r.seller_id = auth.uid()
    )
  );

CREATE POLICY s7_notification_recipient_scopes_seller_update
  ON public.s7_notification_recipient_scopes FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.s7_notification_recipients r
      WHERE r.id = recipient_id AND r.seller_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.s7_notification_recipients r
      WHERE r.id = recipient_id AND r.seller_id = auth.uid()
    )
  );

CREATE POLICY s7_notification_recipient_scopes_seller_delete
  ON public.s7_notification_recipient_scopes FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.s7_notification_recipients r
      WHERE r.id = recipient_id AND r.seller_id = auth.uid()
    )
  );

-- Tipos adicionais para UI seller (não obrigatórios)
INSERT INTO public.s7_notification_event_types (
  category_code, type_key, label, description, severity_default, is_mandatory, default_channels, template_key
)
VALUES
  ('SALES', 'DAILY_SALES_SUMMARY', 'Resumo de vendas do dia', 'Consolidado diário de vendas', 'info', FALSE, '["in_app","email"]', NULL),
  ('SALES', 'ORDER_CANCELLED', 'Venda cancelada', 'Pedido cancelado ou revertido', 'important', FALSE, '["in_app","email","whatsapp"]', NULL),
  ('PROFIT', 'NEGATIVE_MARGIN', 'Margem negativa', 'Venda com margem negativa', 'critical', FALSE, '["in_app","email","whatsapp"]', NULL),
  ('INVENTORY', 'LOW_STOCK', 'Estoque baixo', 'Produto abaixo do mínimo', 'important', FALSE, '["in_app","email"]', NULL),
  ('MARKETPLACE', 'PRICE_CHANGED', 'Alteração de preço', 'Preço público alterado', 'important', FALSE, '["in_app","email"]', NULL),
  ('MARKETPLACE', 'FEE_CHANGED', 'Alteração de tarifa', 'Comissão ou tarifa alterada', 'important', FALSE, '["in_app","email"]', NULL),
  ('COMPETITION', 'COMPETITIVENESS_LOST', 'Perda de competitividade', 'Anúncio perdeu posição', 'medium', FALSE, '["in_app"]', NULL),
  ('SYNC', 'SYNC_FAILED', 'Falha de sincronização', 'Job de sync falhou', 'warning', FALSE, '["in_app","email"]', NULL),
  ('SYSTEM', 'SYSTEM_ALERT', 'Alerta do sistema', 'Alerta operacional da plataforma', 'info', FALSE, '["in_app"]', NULL)
ON CONFLICT (category_code, type_key) DO NOTHING;
