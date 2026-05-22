# CHECKPOINT — S7 Mission Control — Fase 3.5C

**Tag:** `checkpoint:S7-NOTIFY-PHASE-35C`  
**Data:** 2026-05-22  
**Status:** CLOSED — GO

---

## FASE

| Fase | Nome | Status |
|------|------|--------|
| 3.5A | WhatsApp Delivery Engine Base | ✅ (regressão preservada) |
| 3.5B | WhatsApp Sandbox / Test Lab | ✅ CLOSED |
| **3.5C** | **Real Provider Abstraction Layer** | **✅ CLOSED** |

---

## Arquivos criados (3.5C)

### Abstração
- `src/domain/notifications/central/providers/abstraction/deliveryMode.js`
- `src/domain/notifications/central/providers/abstraction/providerChannels.js`
- `src/domain/notifications/central/providers/abstraction/providerCapabilities.js`
- `src/domain/notifications/central/providers/abstraction/providerResponse.js`
- `src/domain/notifications/central/providers/abstraction/providerPolicy.js`
- `src/domain/notifications/central/providers/abstraction/ProviderAdapter.js`
- `src/domain/notifications/central/providers/abstraction/ProviderResolver.js`
- `src/domain/notifications/central/providers/abstraction/providerObservability.js`

### WhatsApp adapters
- `src/domain/notifications/central/providers/whatsapp/resolveWhatsAppProviderAdapter.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/MockWhatsAppAdapter.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/SandboxWhatsAppAdapter.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/LiveWhatsAppAdapterBase.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/MetaWhatsAppAdapter.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/EvolutionWhatsAppAdapter.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/ZapiWhatsAppAdapter.js`
- `src/domain/notifications/central/providers/whatsapp/adapters/TwilioWhatsAppAdapter.js`

### Validação
- `scripts/validatePhase35CProviderAbstraction.mjs`

---

## Arquivos alterados (3.5C)

- `src/domain/notifications/central/whatsapp/S7WhatsAppProvider.js` — facade → `ProviderResolver`
- `src/domain/notifications/central/whatsapp/whatsappSandboxPolicy.js` — env dinâmico
- `src/domain/notifications/central/whatsapp/processWhatsAppOutbox.js` — `dispatch_id` / `attempt` em metadata
- `src/domain/notifications/central/providers/WhatsAppProvider.js` — `isWhatsAppLiveDeliveryActive()`
- `src/infra/config.js` — `S7_APP_ENV`, `S7_ALLOW_LIVE_DELIVERY`
- `.env.example` — documentação env notificações

---

## Variáveis novas

| Variável | Default | Função |
|----------|---------|--------|
| `S7_APP_ENV` | (vazio → NODE_ENV) | Tier lógico: dev / staging / prod |
| `S7_ALLOW_LIVE_DELIVERY` | `false` | Gate explícito para live em DEV/STAGING |
| `S7_WHATSAPP_MODE` | `mock` | `mock` \| `dev_sandbox` \| `live` |
| `S7_WHATSAPP_PROVIDER` | `mock` | `meta` \| `zapi` \| `evolution` \| `twilio` |
| `S7_WHATSAPP_SANDBOX_WHITELIST` | (vazio) | Whitelist 3.5B |

Credenciais live (somente leitura; HTTP na 3.5C.1): `ZAPI_TOKEN`, `EVOLUTION_API_KEY`, `META_WHATSAPP_TOKEN`, `TWILIO_AUTH_TOKEN`.

---

## Fluxo final

```
publishNotificationEvent → dispatch engine → WhatsApp outbox (3.5A)
  → POST /api/internal/notifications/whatsapp/process
  → sendS7WhatsApp()
      → whatsappSandboxPolicy (whitelist 3.5B)
      → ProviderResolver → ProviderAdapter (mock | sandbox | live-stub)
      → ProviderResponse + logs [S7_PROVIDER] + [S7_WHATSAPP]
```

**Live HTTP:** não ativo — adapters live retornam `PROVIDER_NOT_READY`.

---

## Validação (fechamento)

| Script | Resultado |
|--------|-----------|
| `validatePhase35CProviderAbstraction.mjs` | 15/15 PASS |
| `validatePhase35BWhatsAppSandbox.mjs` | 18/18 PASS |
| `validatePhase35AWhatsAppDelivery.mjs` | 23/23 PASS |

---

## Riscos conhecidos

1. **Live acidental** — mitigado por `S7_ALLOW_LIVE_DELIVERY` + `providerPolicy`.
2. **Seller DEV com recipients de teste** — ruído em suítes; usar isolamento nos scripts.
3. **Worker batch sem `dispatchId`** — pode processar `pending` antigos; preferir processamento por dispatch em jobs.
4. **Config cache** — policy lê `process.env` com fallback em `config` para suítes dinâmicas.

---

## Critérios de rollback

1. Reverter commit `checkpoint:S7-NOTIFY-PHASE-35C`.
2. Definir `S7_WHATSAPP_MODE=mock` e `S7_ALLOW_LIVE_DELIVERY=false`.
3. Rodar `validatePhase35AWhatsAppDelivery.mjs` e `validatePhase35BWhatsAppSandbox.mjs`.
4. Outbox/workers inalterados — rollback é só camada provider.

---

## Pronto para próxima fase

**SIM** — abrir **3.5C.1 Z-API Controlled Live Integration** (sem PROD live).

---

## PRÓXIMA MISSÃO — 3.5C.1 (não iniciada)

**Objetivo:** Z-API Controlled Live Integration

### Checklist sugerido

- [ ] Implementar `ZapiWhatsAppAdapter.send()` + `health()` (HTTP)
- [ ] Smoke controlado: 1 seller, 1 número whitelist
- [ ] STAGING + `S7_ALLOW_LIVE_DELIVERY=true` + `S7_WHATSAPP_MODE=live`
- [ ] Timeout e retry alinhados ao outbox (`S7_WHATSAPP_MAX_ATTEMPTS`)
- [ ] Rollback: flag off + revert adapter
- [ ] Observabilidade: `provider_name=zapi`, `duration_ms`, sem token em log
- [ ] Regressão 35C + 35B + 35A após integração
- [ ] PROD permanece `mock` até sign-off dedicado

---

## Auditoria fechamento (PASS)

| Item | Resultado |
|------|-----------|
| Imports órfãos | ✅ adapters referenciados pelo resolver |
| Adapters mortos | ✅ todos registrados (mock/sandbox/live stubs) |
| Env duplicado | ✅ centralizado em `config` + `envOrConfig` onde necessário |
| Logs sensíveis | ✅ `providerObservability` filtra chaves |
| Dependência circular | ✅ abstração → whatsapp adapters; facade → resolver |
| Provider bypass resolver | ✅ único send: `sendS7WhatsApp` → `resolveProviderAdapter` |
| Acoplamento indevido | ✅ email/in_app reservados em `providerChannels` |
