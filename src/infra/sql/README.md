# SUSE7 — Scripts SQL

## audit_events.sql

Cria a tabela `audit_events` para auditoria de alterações em entidades.

**Como aplicar:**
- Via Supabase Dashboard: SQL Editor → colar e executar
- Via CLI: `supabase db push` (se configurado)
- Via migration: copiar para `supabase/migrations/` e rodar `supabase migration up`
