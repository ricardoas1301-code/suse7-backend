-- =============================================================================
-- Pós-reset + Starter ativo — preparar teste renewal engine (PASSO 7)
-- Ajustar período para vencer em 5 dias e rodar job depois.
-- =============================================================================

-- 1) Confirme assinatura Starter ativa (substitua o id se necessário)
SELECT id, status, plan_key, current_period_start, current_period_end, next_due_date
FROM public.billing_subscriptions
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
  AND plan_key = 'start'
  AND status = 'active'
ORDER BY created_at DESC
LIMIT 1;

-- 2) Simular vencimento em 5 dias (troque :subscription_id pelo id da linha acima)
/*
UPDATE public.billing_subscriptions
SET
  current_period_end = (now() + interval '5 days')::timestamptz,
  next_due_date = (now() + interval '5 days')::date,
  updated_at = now()
WHERE id = '<SUBSCRIPTION_ID_STARTER_ATIVO>'
  AND user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50';
*/

-- 3) Após UPDATE, rodar:
-- POST https://suse7-backend-dev.vercel.app/api/jobs/billing-renewal-engine
-- Header: X-Job-Secret

-- 4) Validar ciclo
SELECT *
FROM public.billing_renewal_cycles
WHERE user_id = 'c8a62ec6-cfbe-4ad9-98ea-49fadebeda50'
ORDER BY created_at DESC;
