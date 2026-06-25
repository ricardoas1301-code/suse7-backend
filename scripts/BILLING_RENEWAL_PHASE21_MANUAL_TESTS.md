# Billing Renewal — Fase 2.1 (manual tests)

Pré-requisitos:
- Migration `20260520130000_s7_billing_renewal_notice_state.sql` aplicada no Supabase DEV.
- Backend DEV deployado.
- Seller com assinatura paga (ex.: Start) e método Pix/Boleto manual.

## Job

```http
POST https://suse7-backend-dev.vercel.app/api/jobs/billing-renewal-engine
Authorization: Bearer <JOB_SECRET>
```

## Cenários

### 1 — 3 dias antes
- Ajustar `current_period_end` = hoje + 3 dias.
- Rodar job → ciclo `PRE_RENEWAL`, sem `billing_payment`.
- `GET /api/billing/subscription/status` → `renewal_notice.level` = `WARNING`, título consultivo.
- Banner na Minha assinatura; popup no máximo 1x/dia.

### 2 — 2 dias antes
- `level` = `DANGER`, mensagem reforçada.

### 3 — 1 dia antes
- `level` = `CRITICAL`, CTA **Renovar agora**.

### 4 — vencido há 1 dia (grace)
- `renewal_status` = `GRACE_PERIOD`, `grace_days_remaining` = 9.
- `access_status` = `GRACE`, seller mantém acesso operacional.

### 5 — vencido há 9 dias
- `level` = `CRITICAL`, último aviso.

### 6 — vencido há 10 dias
- `level` = `CRITICAL_FINAL`, banner não dispensável.

### 7 — vencido há 11 dias
- `subscription_status` = `SUSPENDED`, `access_restrictions.operational_blocked` = true.
- Rotas `/vendas`, `/precificacoes`, etc. bloqueadas; `/perfil/assinatura` liberada.

### 8 — renovação no grace
- Clicar **Renovar agora** → Pix/Boleto/Cartão → pagamento confirmado.
- Ciclo `PAID`, notice some, acesso normal.

## Anti-spam

```http
POST /api/billing/renewals/:renewal_cycle_id/notice-seen
{ "event": "popup_shown", "level": "WARNING" }
```

## Histórico

- Ciclo `PRE_RENEWAL` sem `generated_payment_id` → não deve listar cobrança Pix/Boleto pendente.
- Após `POST .../pay` → cobrança aparece com ação correta (QR / 2ª via).
