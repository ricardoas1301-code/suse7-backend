# Fase 3.2.2 — Plano de migration

## Arquivo

`20260522170000_s7_notification_recipient_groups_phase322.sql`

## Impacto

- Adiciona `recipient_group_id` em `s7_notification_recipients` (NOT NULL após backfill).
- Cria `s7_notification_event_delivery_rules` para regras evento × pessoa × canal.
- **Não remove** linhas por canal (Opção A).
- Scopes legados (`s7_notification_recipient_scopes`) permanecem; UI 3.2.2 não usa mais no cadastro.

## Compatibilidade

| Versão | Comportamento |
|--------|----------------|
| API antiga (flat) | `GET /recipients` ainda expõe `recipients` flat + novo `groups` |
| Dispatch sem regras | Fallback: todos destinatários ativos com canal (comportamento 3.2.1) |
| Dispatch com regras | Só `recipient_group_id` habilitados no evento |

## Rollback

1. `DROP TABLE s7_notification_event_delivery_rules;`
2. `ALTER TABLE s7_notification_recipients DROP COLUMN recipient_group_id;`

Dados de destinatários (e-mail/WhatsApp) preservados nas linhas por canal.

## Aplicação

Rodar manualmente no Supabase DEV/PROD — **não** aplicar via CI automático.
