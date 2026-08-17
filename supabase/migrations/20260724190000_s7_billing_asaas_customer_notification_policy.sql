-- S1.HF.ASAAS-NOTIFICATIONS.1 — persistência de confirmação da política de notificação Asaas
-- FORWARD-ONLY · NÃO EXECUTAR nesta missão (apenas documental + RC)
--
-- Objetivo: cache durável de CONFIRMED_DISABLED por seller/customer/ambiente,
-- evitando GET remoto em toda cobrança quando a confirmação é recente.
--
-- Rollback documental: DROP TABLE public.billing_customer_notification_policy;

CREATE TABLE IF NOT EXISTS public.billing_customer_notification_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'asaas',
  environment text NOT NULL,
  provider_customer_id text NOT NULL,
  policy_version text NOT NULL,
  policy_status text NOT NULL,
  notification_disabled_confirmed_at timestamptz,
  last_checked_at timestamptz,
  last_error_code text,
  retry_count integer NOT NULL DEFAULT 0,
  source text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_customer_notification_policy_provider_env_customer_uidx
    UNIQUE (provider, environment, provider_customer_id),
  CONSTRAINT billing_customer_notification_policy_status_chk
    CHECK (policy_status IN (
      'UNKNOWN',
      'PENDING_CONFIRMATION',
      'CONFIRMED_DISABLED',
      'DIVERGENT',
      'RETRYABLE_ERROR',
      'PERMANENT_ERROR',
      'MANUAL_REVIEW'
    ))
);

CREATE INDEX IF NOT EXISTS billing_customer_notification_policy_user_idx
  ON public.billing_customer_notification_policy (user_id);

CREATE INDEX IF NOT EXISTS billing_customer_notification_policy_status_idx
  ON public.billing_customer_notification_policy (policy_status);

COMMENT ON TABLE public.billing_customer_notification_policy IS
  'S1.HF.ASAAS-NOTIFICATIONS.1 — confirmação auditável de notificationDisabled no Asaas. Sem token/PII.';

-- RLS: mesmo padrão tenant user_id (aplicar via helper existente em trilha de deploy).
-- SELECT s7_private.apply_user_id_tenant_rls('billing_customer_notification_policy');

-- Grants mínimos (service_role + authenticated via RLS) — aplicar no deploy autorizado.
-- NÃO armazenar ASAAS_API_KEY / tokens / CPF / e-mail / telefone.
