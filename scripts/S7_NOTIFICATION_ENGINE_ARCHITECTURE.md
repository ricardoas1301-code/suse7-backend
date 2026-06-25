# S7 Central Notification Engine — Fase 3.1

## Princípio

Todos os módulos **publicam eventos** via `publishNotificationEvent()`.  
Nenhum módulo envia email/WhatsApp/push diretamente.

O motor central decide: enviar ou não, destinatários, canal, template e prioridade.

## Camadas

```
Módulo (ex.: billing)
  → publishNotificationEvent()
  → s7_notification_events (append-only, idempotente)
  → notificationDispatchEngine
      → preferências (s7_notification_preferences)
      → destinatários (s7_notification_recipients + scopes)
      → templates (s7_notification_templates)
      → dispatches (s7_notification_dispatches)
      → delivery providers (mock: in_app, email, whatsapp)
      → delivery logs (s7_notification_delivery_logs)
```

## Tabelas

| Tabela | Papel |
|--------|--------|
| `s7_notification_categories` | Categorias oficiais (BILLING, PRODUCTS, …) |
| `s7_notification_event_types` | Catálogo categoria × tipo (mandatory, canais) |
| `s7_notification_events` | Event bus central |
| `s7_notification_preferences` | Seller × categoria × tipo × canal |
| `s7_notification_recipients` | Destinatários por canal |
| `s7_notification_recipient_scopes` | Escopo categoria/tipo por destinatário |
| `s7_notification_templates` | Templates multi-canal |
| `s7_notification_dispatches` | Fila materializada (PENDING → SENT/FAILED/SKIPPED) |
| `s7_notification_delivery_logs` | Auditoria por tentativa |

## Coexistência com Fase 3.0 (billing)

- **Timeline:** `billing_timeline_events` — inalterada.
- **Billing UI notifications:** `billing_notification_dispatches` — inalterada.
- **Motor central:** `s7_notification_*` — nova fonte para escala multi-módulo.

Bridge: `billingCentralNotificationBridge.js` publica no motor central após (ou sem) dispatch billing legado.

## Billing — tipos integrados

- `PAYMENT_CONFIRMED`, `PAYMENT_FAILED`, `PAYMENT_GENERATED`
- `SUSPENDED`, `REACTIVATED`, `ENTERED_GRACE`, `RENEWAL_COMPLETED`

## Mandatory

Tipos `is_mandatory` no catálogo não podem ser totalmente silenciados: `in_app` permanece ativo; ao menos um canal externo é forçado se todos estiverem off.

## Observabilidade

Logs: `[S7_NOTIFICATION]_*`  
DevCenter: `GET /api/dev-center/notifications/engine/summary?hours=24&seller_id=<uuid>`

## Migration

`supabase/migrations/20260522140000_s7_central_notification_engine_phase31.sql`

## Idempotência

- `s7_notification_events (seller_id, idempotency_key)` — evento único.
- Reprocessamento com mesma `idempotency_key`: retorna evento existente, **não** roda dispatch engine (`dispatches.inserted = 0`).
- `force_redispatch: true` — retry explícito futuro (reentrega controlada).
- `s7_notification_dispatches` — índice único por slot `(event_id, channel, recipient_id, destination)` evita duplicata mesmo se o engine for invocado.

## Próximas fases

- Fila/worker real para dispatches QUEUED
- Retry/backoff/rate limit nos providers
- Envio real email/WhatsApp (substituir mock)
- Push provider
- UI de preferências e destinatários no seller
