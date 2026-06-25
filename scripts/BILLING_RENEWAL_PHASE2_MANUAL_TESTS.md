# Testes manuais — Motor de renovação Fase 2

Pré-requisitos: migration aplicada, backend DEV deployado, seller com assinatura Asaas ativa.

## Cenário A — Manual Pix

1. Assinatura com `metadata.payment_method = PIX` e vencimento em ≤7 dias.
2. `POST /api/jobs/billing-renewal-engine` com `X-Job-Secret`.
3. Verificar linha em `billing_renewal_cycles` (`PRE_RENEWAL` ou `PENDING_PAYMENT`).
4. `GET /api/billing/payments` → `action_type=PAY_RENEWAL` ou `VIEW_PIX_QR`.
5. `POST /api/billing/renewals/:id/pay` com `{ "payment_method": "PIX", "explicit_user_action": true }`.
6. Pagar Pix no sandbox; webhook confirma.
7. Ciclo → `PAID`; assinatura renova período.

## Cenário B — Manual Boleto

1. `metadata.payment_method = BOLETO`.
2. Rodar job; histórico → `VIEW_BOLETO` / `PAY_RENEWAL`.
3. Confirmar pagamento via webhook.
4. Ciclo `PAID`.

## Cenário C — Auto Card (sem assinatura recorrente Asaas)

1. Seller com cartão default `supports_auto_renew=true`, sem `provider_subscription_id` (ou estratégia AUTO_CARD forçada em DEV).
2. Job tenta cobrança (`S7_RENEWAL_AUTO_CHARGE_ATTEMPTED`).
3. Pagamento confirmado → `S7_RENEWAL_AUTO_CHARGE_PAID`, ciclo `PAID`.

## Cenário D — Falha cartão

1. Cartão inválido / recusado no sandbox.
2. Ciclo `PAYMENT_FAILED`; metadata grace.
3. Histórico → `UPDATE_CARD`.
4. Seller mantém acesso durante grace (5 dias default).

## Cenário E — Fora do grace

1. Simular `renewal_due_date` >5 dias no passado (DEV).
2. Rodar job.
3. Ciclo `SUSPENDED`; assinatura `past_due`; `can_access=false` no `/api/billing/subscription/status`.

## Logs esperados

- `S7_RENEWAL_ENGINE_START` / `END`
- `S7_RENEWAL_ENGINE_CANDIDATE`
- `S7_RENEWAL_CYCLE_CREATED`
- `S7_RENEWAL_PAYMENT_CREATED`
- `S7_RENEWAL_GRACE_STARTED` / `S7_RENEWAL_SUBSCRIPTION_SUSPENDED`
