# Fase 3.5B — Análise de copy (WhatsApp sandbox)

## Resumo
- Cenários: 11
- Modo: dev_sandbox (sem envio real)
- Ideal: até 500 caracteres por mensagem

## Por cenário

### Billing — pagamento confirmado
- Assunto lógico: Pagamento confirmado
- Caracteres: 129
- CTA: http://localhost:5173/perfil/assinatura/historico

```
✅ Suse7

Seu pagamento do plano Plano Pro (sandbox 3.5B) foi confirmado.

Abra:
http://localhost:5173/perfil/assinatura/historico
```

### Billing — pagamento pendente
- Assunto lógico: Pagamento pendente
- Caracteres: 147
- CTA: http://localhost:5173/perfil/assinatura/historico

```
🚨 Suse7

Pagamento do plano Plano Pro (sandbox 3.5B) está pendente. Regularize no painel.

Abra:
http://localhost:5173/perfil/assinatura/historico
```

### Billing — renovação próxima
- Assunto lógico: Renovação próxima
- Caracteres: 133
- CTA: http://localhost:5173/perfil/assinatura/historico

```
📣 Suse7

A renovação do plano Plano Pro (sandbox 3.5B) está se aproximando.

Abra:
http://localhost:5173/perfil/assinatura/historico
```

### Billing — período de carência
- Assunto lógico: Período de carência
- Caracteres: 132
- CTA: http://localhost:5173/perfil/assinatura/minha-assinatura

```
⚠️ Suse7

Carência no plano Plano Pro (sandbox 3.5B) até 30/06/2026.

Abra:
http://localhost:5173/perfil/assinatura/minha-assinatura
```

### Vendas — prejuízo
- Assunto lógico: Prejuízo na venda
- Caracteres: 90
- CTA: http://localhost:5173/vendas

```
⚠️ Suse7

Venda com margem negativa em Kit Premium ML.

Abra:
http://localhost:5173/vendas
```

### Vendas — margem baixa
- Assunto lógico: Margem em atenção
- Caracteres: 101
- CTA: http://localhost:5173/produtos

```
⚠️ Suse7

Indicadores de margem ou estoque em SKU Margem Baixa.

Abra:
http://localhost:5173/produtos
```

### Marketplace — frete
- Assunto lógico: Frete alterado
- Caracteres: 108
- CTA: http://localhost:5173/perfil/integracoes/mercado-livre

```
📣 Suse7

Alteração de frete no Mercado Livre.

Abra:
http://localhost:5173/perfil/integracoes/mercado-livre
```

### Marketplace — taxa
- Assunto lógico: Taxa alterada
- Caracteres: 107
- CTA: http://localhost:5173/perfil/integracoes/mercado-livre

```
📣 Suse7

Alteração de taxa no Mercado Livre.

Abra:
http://localhost:5173/perfil/integracoes/mercado-livre
```

### Conta — saúde crítica
- Assunto lógico: Conta crítica
- Caracteres: 116
- CTA: http://localhost:5173/perfil/integracoes/mercado-livre

```
🚨 Suse7

Integração Mercado Livre precisa de atenção.

Abra:
http://localhost:5173/perfil/integracoes/mercado-livre
```

### Sync falhou
- Assunto lógico: Sync falhou
- Caracteres: 106
- CTA: http://localhost:5173/notificacoes

```
🚨 Suse7

Sincronização não concluída. Tente novamente no Suse7.

Abra:
http://localhost:5173/notificacoes
```

### Sistema — alerta
- Assunto lógico: Alerta operacional
- Caracteres: 87
- CTA: http://localhost:5173/notificacoes

```
📣 Suse7

Observabilidade DEV (sandbox 3.5B).

Abra:
http://localhost:5173/notificacoes
```

## Refinos recomendados
- Manter título em uma linha (emoji + Suse7).
- Resumo em uma frase; evitar repetir o título no corpo.
- CTA sempre `Abra:` + URL absoluta (mobile-friendly).
- Dark mode: texto puro — OK.
- Billing: tom calmo em confirmação; urgência só em falha/carência.