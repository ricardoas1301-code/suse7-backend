# SUSE7 Backend

Backend Node (Vercel serverless) do projeto SUSE7.

## Desenvolvimento local

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
