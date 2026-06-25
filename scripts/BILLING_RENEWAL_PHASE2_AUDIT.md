# S7 Billing — Fase 2 Motor de Renovação (auditoria)

## O que já existia (reaproveitado)

| Área | Artefatos |
|------|-----------|
| Assinatura | `billing_subscriptions` — `current_period_*`, `next_due_date`, `plan_key`, `metadata.payment_method` |
| Pagamentos | `billing_payments` — cobranças + `raw_payload` |
| Checkout | `billingCheckoutStartService`, `checkoutPlan`, webhooks Asaas |
| Cartão salvo | `billing_payment_methods` (`supports_auto_renew`) |
| Jobs legados | `/api/jobs/billing-process-renewals`, dunning, period-expirations |
| Idempotência legada | `billingRenewalIdempotencyService` (por `billing_payments`) |
| Grace dunning | `billingDunningService` + `metadata.delinquency_*` |

## O que foi criado nesta fase

| Item | Caminho |
|------|---------|
| Migration | `supabase/migrations/20260519120000_s7_billing_renewal_cycles.sql` |
| Constantes | `billingConstants.js` — `RENEWAL_*`, `PAYMENT_HISTORY_ACTION_*` |
| Repositório ciclos | `billingRenewalCycleRepository.js` |
| Estratégia | `billingRenewalStrategyService.js` |
| Motor | `billingRenewalEngine.js` |
| Pagamento renovação | `billingRenewalPaymentService.js` |
| Pay endpoint service | `billingRenewalPayService.js` |
| Ações histórico | `billingPaymentHistoryActions.js` |
| Hooks notificação | `billingRenewalNotificationHooks.js` |
| Job HTTP | `POST /api/jobs/billing-renewal-engine` |
| Pay HTTP | `POST /api/billing/renewals/:renewal_cycle_id/pay` |
| Dev maintenance | `POST /api/billing/dev/process-renewal-engine` |

## O que NÃO foi alterado

- Catálogo `public.plans`
- Fluxo de checkout inicial (Pix/Boleto/Cartão MVP)
- Pix automático / débito
- UI grande (apenas contrato API `action_type` / `action_label`)

## Regra de ouro

Renovação comum **sempre** usa `current_plan_key` / `plan_id` da assinatura ativa.  
`plan_id` / `plan_slug` do frontend são **rejeitados** no pay de renovação.

## Pré-deploy

1. Aplicar migration `20260519120000_s7_billing_renewal_cycles.sql` no Supabase DEV/PROD.
2. Configurar cron: `POST /api/jobs/billing-renewal-engine` (ou manter URL antiga — job legado delega ao motor).
3. Variáveis opcionais: `BILLING_RENEWAL_GRACE_PERIOD_DAYS` (default 5), `BILLING_RENEWAL_PRE_RENEWAL_DAYS` (default 7).
