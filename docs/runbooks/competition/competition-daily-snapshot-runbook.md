# Concorrencia - Atualizacao diaria de concorrentes

## Visao geral

Runbook operacional para:

- publicar backend DEV
- disparar batch manual do motor diario
- validar progresso por logs
- confirmar aceite via SQL no Supabase
- diagnosticar pendencias por causa provavel

Escopo: somente motor diario de concorrencia e observabilidade operacional.

## Deploy backend DEV

```bash
cd c:/ProjetosDev/suse7-backend
vercel --prod --yes
```

Projeto vinculado localmente: `suse7-backend-dev`.

## Endpoint do job

- Endpoint: `https://suse7-backend-dev.vercel.app/api/jobs/competition-daily-snapshot`
- Metodo: `POST` (aceita `GET`, recomendado `POST`)
- Auth preferencial: `x-job-secret: SEU_JOB_SECRET_AQUI`
- Auth alternativa: `Authorization: Bearer SEU_CRON_SECRET_AQUI`

## cURL manual

```bash
curl -X POST "https://suse7-backend-dev.vercel.app/api/jobs/competition-daily-snapshot?limit=25&max_per_run=120" \
  -H "x-job-secret: SEU_JOB_SECRET_AQUI" \
  -H "Content-Type: application/json"
```

## PowerShell 3 rodadas

Arquivo: `competition-daily-snapshot-batch.ps1`

Uso:

```powershell
$env:JOB_SECRET = "SEU_JOB_SECRET_AQUI"
$env:BASE_URL = "https://suse7-backend-dev.vercel.app"
powershell -ExecutionPolicy Bypass -File .\docs\runbooks\competition\competition-daily-snapshot-batch.ps1
```

## SQL de aceite

Arquivo: `competition-daily-snapshot-acceptance.sql`

Validacao alvo:

- `ativos_totais = verificados_hoje_brt`
- `pendentes_hoje_brt = 0`

## SQL pendentes detalhado

Arquivo: `competition-daily-snapshot-pending-details.sql`

Saida com:

- pendentes mais antigos
- `causa_provavel` classificada em:
  - token invalido/ausente
  - anuncio removido/404
  - 403 ML
  - timeout
  - erro interno

## SQL resumo por causa

Arquivo: `competition-daily-snapshot-pending-summary.sql`

Saida com:

- `causa_provavel`
- quantidade
- percentual sobre pendentes
- exemplo de ate 5 `competitor_listing_id` por causa
- menor `ultima_verificacao_efetiva` por causa

## Checklist de logs esperados

Esperar os eventos:

- `[S7_COMPETITION_DAILY_SNAPSHOT] started`
- `[S7_COMPETITION_DAILY_SNAPSHOT] processed`
- `[S7_COMPETITION_DAILY_SNAPSHOT] changed`
- `[S7_COMPETITION_DAILY_SNAPSHOT] unchanged_touched`
- `[S7_COMPETITION_DAILY_SNAPSHOT] errors`
- `[S7_COMPETITION_DAILY_SNAPSHOT] pending_after`

## Criterio de aceite visual

Apos deploy e rodadas manuais:

1. abrir `/admin/dev-center/toolbox` para consulta rapida do runbook
2. abrir pagina de Concorrencia
3. confirmar que concorrentes ativos exibem `Ultima atualizacao` de hoje
4. confirmar SQL de aceite com pendencia zerada

Se ainda houver pendentes:

- rodar SQL detalhado + resumo por causa
- tratar bloqueios operacionais por token/API/timeout
