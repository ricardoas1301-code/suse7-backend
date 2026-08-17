# S1.HF.6.9A.10 — Precedência canônica de acesso

## Resolver único (Node + SQL)

1. Segurança / revogação / tenant desativado  
2. `FINANCIAL_RECOVERY_ONLY`  
3. Pausa administrativa / data-integrity  
4. `BABY_QUOTA` HARD_PAUSED (`hard_pause_owner = BABY_QUOTA_ENGINE`)  
5. Uso pago restrito  
6. Trial / full normal  

Trial ilimitado **bypassa somente QUOTA** — nunca antes de avaliar 1–5.

## Materialização da pausa Baby

```
hard_pause_owner = BABY_QUOTA_ENGINE
hard_pause_cycle_key = <ciclo>
hard_pause_source = RUNTIME | MIGRATION_BASELINE
hard_pause_started_at = <ts>
hard_pause_reason = BABY_LIMIT_REACHED
```

## Rollover / finalize / release / expire

- Limpa **somente** condição BABY_QUOTA do ciclo anterior (owner + cycle_key)
- Em seguida chama o resolver de precedência
- Restrição financeira/segurança surgida depois da reserva **permanece**
- Não restaurar `FULL_ACCESS` a partir de snapshots antigos

## Aplicação

- `preflightBillableSaleEntitlementState`
- `reserveBillableSaleAfterOfficialDate`
- `evaluateBillableSaleBeforeProcessingAtomic`
- `notifyBillableSaleRecorded`
- `billing_reserve_billable_sale_v2`
- finalize / release / expire / rollover (SQL)

## PARADA

Artefatos apenas — DEV/PROD intactos.
