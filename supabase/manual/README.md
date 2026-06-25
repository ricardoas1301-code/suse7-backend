# Supabase SQL Editor — entrega manual (copy/paste)

Use quando não estiver usando `supabase db push` / CLI no projeto.

## Notifications — Delivery + Manual Retry (`manual_retry_count`)

**Pré-requisitos no projeto:** `public.marketplace_accounts` (FK nas migrations); opcionalmente `public.notifications` para coluna `notification_event_id`.

1. Abra **Supabase Dashboard → SQL Editor → New query**.
2. Cole e rode **um arquivo só**:

   - [`supabase_sql_editor_notifications_delivery_manual_bundle.sql`](./supabase_sql_editor_notifications_delivery_manual_bundle.sql)

   Equivale à sequência idempotente em `supabase/migrations/`:

   | Ordem | Arquivo fonte |
   | ----- | ------------- |
   | 1 | `20260508120000_notification_contacts_and_routing.sql` |
   | 2 | `20260509120000_notification_delivery_engine.sql` |
   | 3 | `20260510100000_notification_delivery_manual_retry.sql` |

**Manutenção:** a fonte canônica continua sendo `supabase/migrations/*.sql`. Se alterar o schema, atualize primeiro os migrations e depois regereste o bundle (ou aplique só os arquivos incrementais que mudaram).

## Opcional — fila marketplace (priority / locks)

Worker permanece compatível sem isto; use quando for adotar prioridade explícita na tabela `marketplace_account_sync_jobs`:

- [`optional_marketplace_account_sync_jobs_queue_phase2.sql`](./optional_marketplace_account_sync_jobs_queue_phase2.sql)  
  (mesmo conteúdo de `sql/marketplace_account_sync_jobs_queue_phase2.sql`)
