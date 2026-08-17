# Regra oficial — 1 renewal cycle OPEN por assinatura (Fase 2.1)

## Invariante

Para cada `subscription_id` em `billing_renewal_cycles`:

**No máximo 1** linha com `renewal_status` em estado **OPEN**.

## Estados OPEN (persistidos)

- `SCHEDULED`
- `PRE_RENEWAL`
- `PENDING_PAYMENT`
- `AUTO_CHARGE_PROCESSING`
- `PAYMENT_FAILED`
- `GRACE_PERIOD`
- `SUSPENDED`

## Estados CLOSED (terminais)

- `PAID`, `CANCELED`, `SKIPPED`, `SUPERSEDED`, `EXPIRED`, `CLOSED`

## Alertas UI (não são renewal_status)

`WARNING`, `DANGER`, `CRITICAL` vivem em `RENEWAL_ALERT_LEVEL` (motor de notice), não como status de ciclo.

## Proteção no banco

Índice único parcial: `billing_renewal_cycles_one_open_per_subscription_idx`  
(migration `20260520160000_s7_billing_renewal_one_open_cycle.sql`).

## Motor

Antes de `insertRenewalCycle`:

1. `reconcileOpenRenewalCyclesForSubscription` — fecha duplicados como `SUPERSEDED`
2. Reutiliza ciclo canônico OPEN e sincroniza janela (`cycle_start` / `cycle_end` / `renewal_due_date`)
3. Só insere se não houver OPEN nem match de idempotência
4. Em `23505`, reconcilia e reutiliza

Logs: `[BILLING RENEWAL CONSISTENCY]` + `S7_RENEWAL_CYCLE_CONSISTENCY`.
