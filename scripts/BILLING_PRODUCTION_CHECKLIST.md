# S7 Billing — Production Readiness Checklist (Fase 3.0.4)

Use antes de promover billing experience para produção.

## Ambiente e secrets

- [ ] `ASAAS_ENV=production` (ou sandbox apenas em DEV)
- [ ] `ASAAS_API_BASE_URL` apontando para API correta
- [ ] `ASAAS_API_KEY` de produção (não sandbox)
- [ ] `ASAAS_WEBHOOK_TOKEN` configurado no Asaas e no Vercel
- [ ] `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` do projeto correto
- [ ] `JOB_SECRET` definido (jobs `X-Job-Secret`)
- [ ] Frontend: `VITE_API_BASE_URL` → backend de produção
- [ ] Frontend: `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`

## Migrations Supabase

- [ ] `20260520160000_s7_billing_renewal_one_open_cycle.sql`
- [ ] `20260521120000_s7_billing_phase30_revenue_experience.sql`
- [ ] `20260521130000_s7_billing_payment_generated_template.sql`
- [ ] `20260521140000_s7_billing_phase304_performance_indexes.sql`

## Webhooks Asaas

- [ ] URL: `https://<backend>/api/billing/webhooks/asaas`
- [ ] Header/token `asaas-access-token` igual ao `ASAAS_WEBHOOK_TOKEN`
- [ ] Eventos: PAYMENT_CREATED, CONFIRMED, RECEIVED, OVERDUE (mínimo)
- [ ] Teste de reenvio → resposta `duplicate: true`

## Cron / jobs

- [ ] `POST /api/jobs/billing-renewal-engine` (diário) com `X-Job-Secret`
- [ ] `POST /api/jobs/billing-consistency-check` (semanal ou diário DEV) com `auto_reconcile_open_cycles: true` se desejado
- [ ] Jobs legados delegando ao motor (opcional manter por compat)

## Validação funcional

- [ ] Checkout → pagamento sandbox → timeline `PAYMENT_CONFIRMED`
- [ ] `GET /api/billing/timeline` autenticado
- [ ] `GET /api/billing/revenue-health`
- [ ] `GET /api/billing/notifications`
- [ ] Histórico `/perfil/assinatura/historico` sem `?preview=finance`
- [ ] Reenvio webhook sem duplicar timeline

## Hardening Fase 3.0.4

- [ ] Logs `[BILLING TEST]` ausentes em produção
- [ ] `?preview=finance` inativo em build produção (`import.meta.env.DEV`)
- [ ] Consistency check: `issues_count` aceitável ou reconciliado

## Rollback

- [ ] Tag/release anterior documentada
- [ ] Migrations são forward-only; rollback de código sem drop de tabelas phase 3.0
