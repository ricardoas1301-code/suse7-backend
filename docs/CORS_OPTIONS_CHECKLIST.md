# CORS / OPTIONS — Checklist de Deploy

## Objetivo
Garantir que requisições OPTIONS (preflight) sempre chegam e respondem 204 para CORS funcionar.

## Fluxo atual

1. **middleware.js** — Responde OPTIONS na borda com 204 + headers CORS
2. **vercel.json** — Headers CORS estáticos + rewrite `/api/:path*` → `/api`
3. **api/index.js** — `applyCors` como fallback (caso OPTIONS chegue à função)

## ⚠️ Deployment Protection

Se o projeto tiver **Deployment Protection** ativo (Vercel Auth, senha, Trusted IPs), requisições OPTIONS podem ser bloqueadas com **403** antes do middleware rodar. Isso causa o erro:

> "Response to preflight request doesn't pass access control check: It does not have HTTP ok status."

### Opção A (recomendada): OPTIONS Allowlist

1. Acesse: **Vercel Dashboard** → **suse7-backend** → **Settings** → **Deployment Protection**
2. Localize **OPTIONS Allowlist** (ou "Methods to bypass")
3. Adicione o path: `/api`
4. Salve

Isso permite que requisições OPTIONS para `/api/*` bypassem a proteção e cheguem ao middleware.

### Opção B: Desativar proteção temporariamente

Para teste rápido, desative temporariamente a proteção em Settings → Deployment Protection.

### Verificação

```bash
curl -i -X OPTIONS "https://suse7-backend.vercel.app/api/notifications" \
  -H "Origin: https://suse7.com.br" \
  -H "Access-Control-Request-Method: GET"
```

A resposta deve ter:
- **Status:** 204 No Content
- **Headers:** `Access-Control-Allow-Origin: https://suse7.com.br`
