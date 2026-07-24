# S1.HF.6.9A.10 — Classificação, ciclo civil e origem

## Status

- Pacote **substitutivo** da 6.9A.9 (não cumulativo).
- Forward único: `20260723140000_…hardening_6_9a10.sql`
- **Nenhum SQL aplicado** em DEV/PROD.

## Regras comerciais preservadas

- Histórico 12 meses e vendas do trial sempre visíveis
- Sem DELETE/TRUNCATE/purge
- Trial 15 dias civis, ilimitado por volume
- `quota_counting_started_at` só após saída do trial
- Baby/pago nascem 0/limite
- Histórico/trial nunca entram retroativamente na franquia
- **PAID_PLAN fora** desta migration Baby

## Data oficial

Somente `order.date_created` (Mercado Livre).

Não usar: `date_closed`, `sales_orders.created_at`, `inserted_at`, data de sync.

Ausente após início da quota → `manual_review_required`, webhook 2xx, sem admission normal, sem `quota_bypassed` silencioso.

## Origem canônica (única resolução)

| Valor | Uso |
|-------|-----|
| `onboarding_import` | ml_initial_* / ml_historical_* |
| `operational_webhook` | webhook |
| `operational_reconciliation` | reconciliação |
| `operational_sync` | sync operacional |
| `unknown` | ausência — **nunca** `post_suse7_sale` |

## Ciclo civil (America/Sao_Paulo)

Janela semiaberta:

`cycle_started_at <= official_order_at < cycle_ends_at_exclusive`

Sem concatenar `T00:00:00.000Z` / `T23:59:59.999Z`.

## Baseline por identidade

`eligible_sales EXCEPT active_admissions = 0`  
`active_admissions EXCEPT eligible_sales = 0`

## PARADA

Não executar SQL / RPC / grant / deploy / cobrança. Nenhuma cobrança/provider financeiro acionado nesta missão.
