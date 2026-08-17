# CHECKPOINT — S7 Mission Control — Fase 3.5C.1

**Tag:** `checkpoint:S7-NOTIFY-PHASE-35C1`  
**Data:** 2026-05-22  
**Status:** CLOSED — GO (código) | Smoke real GO condicional | PROD live NO-GO

---

## 1. Status da fase

| Item | Status |
|------|--------|
| `ZapiWhatsAppAdapter.send()` | ✅ HTTP controlado |
| `ZapiWhatsAppAdapter.health()` | ✅ `/status` |
| `providerLiveDeliveryGate` | ✅ |
| `providerSmokePolicy` | ✅ 1 seller / 1 phone |
| `zapiHttpClient` | ✅ timeout 5s |
| Logs mascarados `[S7_PROVIDER]_*` | ✅ |
| Rollback via env | ✅ |
| Migration nova | ❌ nenhuma |
| PROD live | ❌ bloqueado |
| UX / Raio-X / Manual Dispatch | ❌ não tocados |

---

## 2. Arquivos criados

- `src/domain/notifications/central/providers/abstraction/providerHealthResult.js`
- `src/domain/notifications/central/providers/abstraction/providerLiveDeliveryGate.js`
- `src/domain/notifications/central/providers/abstraction/providerSmokePolicy.js`
- `src/domain/notifications/central/providers/whatsapp/zapiHttpClient.js`
- `scripts/validatePhase35C1ZapiControlledLive.mjs`

(`ZapiWhatsAppAdapter.js` substitui stub da 3.5C.)

---

## 3. Arquivos alterados

- `src/domain/notifications/central/providers/whatsapp/adapters/ZapiWhatsAppAdapter.js`
- `src/domain/notifications/central/providers/abstraction/providerPolicy.js`
- `src/domain/notifications/central/providers/abstraction/providerObservability.js`
- `src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js`
- `src/infra/config.js`
- `.env.example`

---

## 4. Variáveis de ambiente novas

| Variável | Função |
|----------|--------|
| `S7_ZAPI_BASE_URL` | Base da instância (`.../instances/{id}/token/{token}`) |
| `S7_ZAPI_TOKEN` | Header `Client-Token` (opcional; fallback `ZAPI_TOKEN`) |
| `S7_PROVIDER_SMOKE_ENABLED` | `true` para liberar live Z-API |
| `S7_PROVIDER_SMOKE_SELLER` | UUID do único seller autorizado |
| `S7_PROVIDER_SMOKE_PHONE` | Telefone whitelist smoke |
| `S7_ZAPI_SMOKE_RUN` | `true` no script para smoke HTTP real opcional |

Requer também (já existentes 3.5C):

- `S7_WHATSAPP_MODE=live`
- `S7_ALLOW_LIVE_DELIVERY=true`
- `S7_WHATSAPP_PROVIDER=zapi`
- `S7_APP_ENV=development` ou `staging` (nunca `production` para live)

---

## 5. Gates de segurança

1. **PROD** → `PROD_LIVE_BLOCKED` (sempre mock efetivo em produção).
2. **Live gate** → exige `S7_WHATSAPP_MODE=live` **e** `S7_ALLOW_LIVE_DELIVERY=true`; senão `LIVE_DELIVERY_DISABLED`.
3. **Smoke policy** → `S7_PROVIDER_SMOKE_ENABLED=true` + seller + phone configurados; senão `BLOCKED_BY_SMOKE_POLICY`.
4. **Z-API config** → `S7_ZAPI_BASE_URL` obrigatório; senão `ZAPI_NOT_CONFIGURED`.
5. **Sandbox 3.5B** → em `dev_sandbox`, whitelist de canal continua válida antes do adapter.

Retry: apenas outbox existente (`S7_WHATSAPP_MAX_ATTEMPTS`) — sem retry paralelo no adapter.

---

## 6. Como executar smoke real

```bash
cd suse7-backend

# .env.local (exemplo)
S7_APP_ENV=development
S7_WHATSAPP_MODE=live
S7_WHATSAPP_PROVIDER=zapi
S7_ALLOW_LIVE_DELIVERY=true
S7_ZAPI_BASE_URL=https://api.z-api.io/instances/INSTANCE_ID/token/INSTANCE_TOKEN
S7_ZAPI_TOKEN=<se aplicável>
S7_PROVIDER_SMOKE_ENABLED=true
S7_PROVIDER_SMOKE_SELLER=<uuid-seller-dev>
S7_PROVIDER_SMOKE_PHONE=5511999999999
S7_ZAPI_SMOKE_RUN=true

node scripts/validatePhase35C1ZapiControlledLive.mjs
```

Validar logs: `[S7_PROVIDER]_START` → `_SUCCESS` com `to_masked` (ex.: `*********9999`).

---

## 7. Como fazer rollback

Imediato (sem deploy de código):

```env
S7_ALLOW_LIVE_DELIVERY=false
S7_WHATSAPP_MODE=mock
S7_PROVIDER_SMOKE_ENABLED=false
```

Confirmar:

```bash
node scripts/validatePhase35AWhatsAppDelivery.mjs
node scripts/validatePhase35BWhatsAppSandbox.mjs
node scripts/validatePhase35CProviderAbstraction.mjs
```

---

## 8. Scripts executados (fechamento)

| Script | Resultado |
|--------|-----------|
| `validatePhase35C1ZapiControlledLive.mjs` | **18/18 PASS** |
| `validatePhase35CProviderAbstraction.mjs` | **15/15 PASS** |
| `validatePhase35BWhatsAppSandbox.mjs` | **18/18 PASS** |
| `validatePhase35AWhatsAppDelivery.mjs` | **23/23 PASS** |

---

## 9. Resultado dos testes

- **Total automatizado:** 74/74 PASS (sem HTTP real obrigatório no CI local).
- Smoke HTTP real: coberto por testes opcionais quando `S7_ZAPI_SMOKE_RUN=true` + credenciais válidas.

---

## 10. Pendência explícita

- **Smoke real com Z-API** depende de:
  - credenciais válidas (`S7_ZAPI_BASE_URL`, token se necessário);
  - instância Z-API conectada (`health.connected === true`);
  - execução manual em DEV/STAGING com flags smoke;
  - **não** é bloqueante para fechar o código da 3.5C.1.

---

## 11. Decisão

| Dimensão | Veredito |
|----------|----------|
| **Código 3.5C.1** | **GO** — fase encerrada |
| **Smoke real** | **GO condicional** — após credenciais + `S7_ZAPI_SMOKE_RUN=true` |
| **PROD live** | **NO-GO** |

---

## PRÓXIMA MISSÃO SUGERIDA — 3.5C.1.A (não iniciada)

**Z-API Real Smoke Execution**

**Objetivo:** executar 1 envio real controlado e registrar evidência.

**Condições:**

- [ ] 1 seller (`S7_PROVIDER_SMOKE_SELLER`)
- [ ] 1 telefone (`S7_PROVIDER_SMOKE_PHONE`)
- [ ] Ambiente local ou STAGING
- [ ] `S7_ZAPI_SMOKE_RUN=true`
- [ ] `health()` retorna `connected: true`
- [ ] 1 `send()` com `provider_message_id` real
- [ ] Logs mascarados revisados
- [ ] Rollback validado (`S7_ALLOW_LIVE_DELIVERY=false`)

**Não fazer nesta subfase:** ampliar whitelist, PROD, Manual Dispatch, Raio-X.
