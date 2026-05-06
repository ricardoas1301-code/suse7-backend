# Configuração de variáveis de ambiente (DEV local × PROD)

## Resumo

1. **Local/DEV** — Use `suse7-backend/.env.local`. Este arquivo **não é commitado** e é onde você coloca secrets de desenvolvimento.
2. **PROD** — Configure variáveis no painel da **Vercel** (Environment Variables). **Não** versionar secrets de produção em arquivo no repositório.
3. **Nunca commitar** `.env`, `.env.local`, nem arquivos com segredos reais.
4. **Ordem de carregamento** — O servidor local carrega primeiro `.env` e depois `.env.local`. O **`.env.local` sobrescreve** chaves definidas em `.env`.
5. **Armadilha comum** — Se uma variável existir em `.env` preenchida e você declarar a **mesma chave vazia** em `.env.local` (ex.: `ML_CLIENT_SECRET=`), o valor vazio **vence** e quebra OAuth/jobs. Remova a linha vazia ou preencha corretamente.
6. **Mercado Livre em teste local** — Use o **app ML DEV** (client id/secret de desenvolvimento) alinhado ao callback cadastrado no painel ML.
7. **Mercado Livre em produção** — Use o **app ML PROD** apenas nas envs da Vercel, nunca misturado no `.env.local` de trabalho diário sem intenção.

## Modelo

Veja `suse7-backend/.env.example` — apenas placeholders, sem valores sensíveis.

## Checklist para preencher (Rico)

| Variável | Local/DEV (`.env.local`) | Produção (Vercel) |
| --- | --- | --- |
| `FRONTEND_URL` | `http://localhost:5173` (ou URL do frontend em dev) | URL do frontend em produção |
| `ML_CLIENT_ID` | App Mercado Livre **DEV** | App Mercado Livre **PROD** |
| `ML_CLIENT_SECRET` | Secret do app **DEV** | Secret do app **PROD** |
| `ML_REDIRECT_URI` | Callback do backend **DEV** (cadastrado no app ML) | Callback do backend **PROD** |
| `SUPABASE_URL` | Projeto Supabase **DEV** | Projeto Supabase conforme ambiente alvo |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role **DEV** | Service role **PROD** (ou ambiente correspondente) |
| `ML_WEBHOOK_JOB_SECRET` / `JOB_SECRET` | Secret interno para jobs em dev | Secret interno para jobs em prod |
| `S7_PROD_WEBHOOK_JOB_URL` | Vazio ou opcional local | URL do job de webhook em produção (cron/GitHub Actions) |

Variáveis opcionais de bloqueio local (evitar client id de PROD no dev):

- `ML_LOCAL_DEV_FORBIDDEN_CLIENT_IDS`
- `ML_LOCAL_DEV_EXPECTED_CLIENT_ID`

Consulte os comentários em `.env.example` e o código em `src/dev-server.js` para detalhes de carregamento.
