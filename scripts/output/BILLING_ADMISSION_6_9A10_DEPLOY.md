# S1.HF.6.9A.10 — Ordem de deploy (após homologação)

**PARADA atual:** não executar.

1. `scripts/sql/billing_admission_atomic_precheck_6_9a10.sql`
2. Forward `…hardening_6_9a10.sql`
3. `…postcheck_6_9a10.sql` (EXCEPT=0, incomplete=0, ok)
4. DEV only: seed → grant → postgrant (`ok=true`, 7 EXECUTE)
5. Agendar cron: `POST /api/jobs/billing-billable-sale-admission-reconciler` a cada 60s
