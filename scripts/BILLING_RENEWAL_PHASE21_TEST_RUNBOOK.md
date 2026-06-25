# Fase 2.1 — Testes controlados acelerados (DEV)

## Pré-requisitos

1. Migrations aplicadas (`billing_renewal_cycles`, `billing_renewal_notice_state`).
2. Backend DEV com deploy recente.
3. Variável no **backend DEV** (Vercel ou local):
   ```
   BILLING_RENEWAL_TEST_ACCELERATED=1
   ```
   Efeito: **1 minuto = 1 dia simulado** (grace 10 min, alertas 3/2/1 min antes do vencimento).
4. `.env.local` no `suse7-backend` com `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEV_JOB_SECRET`.

## 1 — Identificar seller

```powershell
cd c:\ProjetosDev\suse7-backend
node scripts/billingPhase21DiagnoseSeller.mjs --email=SEU_EMAIL_TESTE
```

Anote: `user_id`, `subscription_id`, `billing_cycle_anchor`, `seller_company_id`.

## 2 — Roteiro acelerado (cronologia sugerida)

| Passo | Comando | Esperado (após job + refresh UI) |
|-------|---------|----------------------------------|
| ACTIVE | `--scenario=active --run-engine` | Acesso liberado, sem banner crítico |
| WARNING | `--scenario=warning --run-engine` | `renewal_notice.level` = WARNING |
| DANGER | `--scenario=danger --run-engine` | level DANGER, visual laranja |
| CRITICAL | `--scenario=critical --run-engine` | level CRITICAL, CTA Renovar agora |
| GRACE | `--scenario=grace --run-engine` | GRACE_PERIOD, acesso mantido |
| SUSPENDED | `--scenario=suspended --run-engine` | Bloqueio operacional, billing liberado |
| REACTIVATED | Pagamento real/sandbox + confirmar | ACTIVE, grace limpo |
| RESTORE | `--scenario=restore` | Volta snapshot pré-teste |

```powershell
node scripts/billingPhase21AcceleratedScenario.mjs --email=SEU_EMAIL --scenario=warning --run-engine
```

Aguarde ~1 min entre mudanças se quiser ver transições em tempo real.

## 3 — Validação backend

```http
GET https://suse7-backend-dev.vercel.app/api/billing/subscription/status
Authorization: Bearer <token seller>
```

Campos: `renewal_notice`, `access_status`, `access_restrictions`, `pending_renewal`.

## 4 — Logs

No Vercel/logs do job:

```
[BILLING TEST] status_transition
[BILLING TEST] scenario_applied
S7_RENEWAL_NOTICE_COMPUTED
```

## 5 — Restaurar

```powershell
node scripts/billingPhase21AcceleratedScenario.mjs --email=SEU_EMAIL --scenario=restore
```

Remove `_billing_test_snapshot` e restaura datas/status.

## 6 — Resultados

Preencher: `BILLING_RENEWAL_PHASE21_TEST_RESULTS.md` (template abaixo).

---

## Checklist visual

- [ ] ACTIVE — consumo e plano corretos
- [ ] WARNING — banner, anti-spam popup ≤1x/dia
- [ ] DANGER — tom forte
- [ ] GRACE — acesso OK + aviso
- [ ] SUSPENDED — gate em /vendas, liberado em /perfil/assinatura
- [ ] REACTIVATED — pós-pagamento tudo normal
- [ ] Anchor original preservado (diagnose antes/depois)
