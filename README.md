# SUSE7 Backend

Backend Node (Vercel serverless) do projeto SUSE7.

## Desenvolvimento local

### Variáveis de ambiente (DEV)

O servidor local **carrega o arquivo `.env`** na raiz do backend (via `dotenv`). Sem isso, chamadas que usam Supabase (ex.: `/api/user/preferences`, `/api/notifications`) retornam **500** ou **503**.

**Importante:** O backend precisa usar o **mesmo projeto Supabase** que o frontend. Se o frontend usa `VITE_SUPABASE_URL=https://xxxx.supabase.co` no `.env.development`, o backend deve ter no seu `.env`:

- `SUPABASE_URL` = **o mesmo valor** (ex.: `https://xxxx.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY` = chave **service_role** desse projeto (Dashboard Supabase → Settings → API)

Se `SUPABASE_URL` ou a chave forem de outro projeto (ou vazios), o backend retorna **401** ao validar o token do frontend — mesmo com login ok no front.

Ao subir o servidor com `npm run dev`, o backend loga no console a `SUPABASE_URL` (mascarada) e se a service role está definida. Use isso para conferir que bate com o frontend.

1. Copie o exemplo e preencha com os valores do seu projeto Supabase:
   ```bash
   cp .env.example .env
   ```
2. No `.env`, defina pelo menos:
   - `SUPABASE_URL` — URL do projeto (ex.: `https://xxxx.supabase.co`) — **mesmo do frontend (VITE_SUPABASE_URL)**
   - `SUPABASE_SERVICE_ROLE_KEY` — chave "service_role" (Dashboard Supabase → Settings → API)

O frontend envia o token de sessão no header `Authorization: Bearer <token>`. Usuário não logado ou token inválido resulta em **401**; isso é esperado até o login no front.

### Porta

O servidor de desenvolvimento sobe em **porta 3001** por padrão, para bater com o frontend (`VITE_API_BASE_URL=http://localhost:3001/api`).

- Use `PORT` para mudar: `PORT=3000 npm run dev` (Linux/mac) ou `$env:PORT=3000; npm run dev` (PowerShell).
- Recomendado: deixar **3001** no DEV e no frontend (`.env.development`: `VITE_API_BASE_URL=http://localhost:3001/api`).

### Comandos

```bash
# Servidor local (Express-like, repassa /api/* para o handler da Vercel)
npm run dev
```

- Backend: <http://localhost:3001>
- Health: <http://localhost:3001/api/health> (200 JSON)

### PowerShell — política de execução

Se `npm run dev` ou `npx vercel dev` falhar por bloqueio de scripts (ex.: `npm.ps1`), use **apenas na sessão atual** (não altera política global):

```powershell
Set-ExecutionPolicy Bypass -Scope Process
```

Depois rode `npm run dev` ou `npx vercel dev` no mesmo terminal.

### Vercel local (opcional)

```bash
npm run dev:vercel
```

Escuta na porta 3001 (`vercel dev --listen 3001`).

## Produção

Deploy na Vercel; o entry é `api/index.js` (rewrites em `vercel.json`).
