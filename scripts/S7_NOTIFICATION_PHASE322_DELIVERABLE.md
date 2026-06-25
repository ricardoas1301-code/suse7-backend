# Fase 3.2.2 — Entrega (UX + modelo destinatários)

## 1. Arquivos alterados

### Backend
| Arquivo | Mudança |
|---------|---------|
| `supabase/migrations/20260522170000_s7_notification_recipient_groups_phase322.sql` | Grupos + tabela de regras |
| `scripts/S7_NOTIFICATION_PHASE322_MIGRATION_PLAN.md` | Plano rollback/impacto |
| `src/domain/notifications/central/seller/sellerNotificationRecipientGroupsService.js` | CRUD pessoa (Opção A) |
| `src/domain/notifications/central/seller/sellerNotificationEventDeliveryRulesService.js` | Regras evento × grupo × canal |
| `src/domain/notifications/central/seller/sellerNotificationRecipientsService.js` | `recipient_group_id` no create legado |
| `src/domain/notifications/central/seller/sellerNotificationPreferencesService.js` | UI: só `in_app`; bloqueia patch email/WA |
| `src/domain/notifications/central/seller/validateMandatoryPreferences.js` | Mandatory = in_app |
| `src/domain/notifications/central/recipients/resolveCentralRecipients.js` | Regras + fallback scopes |
| `src/domain/notifications/central/dispatches/notificationDispatchEngine.js` | Email/WA fora do toggle global |
| `src/handlers/notifications/sellerNotificationSellerApi.js` | Groups + event-delivery-rules |
| `api/index.js` | Rota `event-delivery-rules` |
| `scripts/validatePhase322RecipientUx.mjs` | Suíte API 3.2.2 |

### Frontend
| Arquivo | Mudança |
|---------|---------|
| `src/components/notifications/central/recipientContactUi.js` | Validação + máscara WhatsApp |
| `src/components/notifications/central/NotificationRecipientModal.jsx` | Form pessoa (sem canal/categorias) |
| `src/components/notifications/central/NotificationRecipientCard.jsx` | Card por grupo |
| `src/components/notifications/central/NotificationEventRecipientRules.jsx` | Checkboxes por evento |
| `src/components/notifications/central/NotificationPreferenceGroup.jsx` | Só in_app + destinatários |
| `src/components/notifications/central/NotificationCategoryCard.jsx` | Props regras |
| `src/components/Profile/CentralNotificacoesHub.jsx` | Abas 3.2.2 |
| `src/hooks/useCentralNotificationSettings.js` | Groups + rules |
| `src/services/centralNotificationsApi.js` | Novos endpoints |

## 2. Mudanças backend

- **Opção A (menor risco):** 1 linha por canal; `recipient_group_id` agrupa pessoa.
- **POST/PATCH/DELETE** `/api/notifications/recipients` aceitam payload pessoa (`label`, `email`, `whatsapp`).
- **Compat:** payload legado `channel` + `destination` ainda funciona (3.2.1).
- **GET** retorna `groups` + `recipients` (flat).
- **Novas rotas:** `GET/PATCH /api/notifications/event-delivery-rules`.
- **Dispatch:** email/WhatsApp não dependem mais de toggle global; destinatários vêm de regras (ou fallback scopes/ativos).

## 3. Mudanças frontend

- Modal: Nome, Função, E-mail, WhatsApp, Ativo — validação inline, salvar desabilitado se inválido.
- Preferências: só toggle **Notificações no app**; por evento, bloco **Destinatários** com checkboxes E-mail/WhatsApp por pessoa.
- Aba Destinatários: cards por pessoa (não por canal).

## 4. Migration necessária

**Sim** — `20260522170000_s7_notification_recipient_groups_phase322.sql`

- **Não aplicar automaticamente.**
- Sem migration: create grupo e regras falham (coluna/tabela inexistente).

## 5. Estratégia compatibilidade

| Cenário | Comportamento |
|---------|----------------|
| Sem regras no evento | Fallback 3.2.1 (scopes ou todos ativos no canal) |
| Com regras | Só grupos habilitados naquele evento/canal |
| API legada POST canal | Continua; cada linha ganha `recipient_group_id` próprio |
| Prefs email/WA antigas no DB | Ignoradas na UI; dispatch usa regras + catálogo |

## 6. Testes

```bash
# Após migration + deploy DEV
node scripts/validatePhase322RecipientUx.mjs

# Regressão 3.2.1 (API legada)
node scripts/validatePhase321RecipientIntegrity.mjs
```

**Manual (Rico):** checklist abaixo.

## 7. Checklist Rico

- [ ] Migration `20260522170000` aplicada em DEV
- [ ] Deploy backend DEV
- [ ] Deploy frontend produção/DEV
- [ ] Criar José só e-mail
- [ ] Criar Maria só WhatsApp (máscara, sem letras)
- [ ] Criar Pedro com ambos
- [ ] Bloquear salvar com ambos vazios
- [ ] F5 — dados persistem
- [ ] Evento: marcar José → e-mail + WhatsApp, salvar, F5
- [ ] Billing checkout / assinatura (regressão)
- [ ] Central 3.1.1 in-app mandatory

## 8. Go / No-Go

| Critério | Status |
|----------|--------|
| Código 3.2.2 completo no repo | **Go** |
| Migration aplicada em DEV | **Pendente (Rico)** |
| Deploy backend DEV | **Pendente** |
| `validatePhase322` verde | **Pendente pós-migration+deploy** |
| Testes manuais UI | **Pendente** |

**Recomendação:** **Go para merge/deploy** após Rico aplicar migration e rodar suítes. **No-Go para fechar 3.2.2 em PROD** até migration + validação DEV.
