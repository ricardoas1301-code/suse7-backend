# MISSAO — SSOT Fase 2B (Correcoes P1 + Nova Homologacao Global)

Data: 2026-06-23  
Base anterior: `scripts/output/ssot_global_audit_phase2_2026-06-23.md`

## 1) Arquivos alterados

- `suse7-backend/src/domain/sales/loadSaleOrderItemForSeller.js`
- `suse7-backend/src/handlers/sales/summary.js`
- `suse7-frontend/src/utils/productCatalogRow.js`

## 2) Correcoes aplicadas

### 2.1 `loadSaleOrderItemForSeller` (P1)

- Removido uso de `products` atuais (`cost_price`, `packaging_cost`, `operational_cost`) para montar financeiro.
- Removido uso de `resolveSaleInternalTaxProfile` (imposto atual) no payload manual.
- Agora o cálculo usa `buildSaleDetailFinancialBreakdown(item, null, order, null, {})` (snapshot-first).
- Quando snapshot interno está ausente, o payload é explicitamente marcado com:
  - `snapshot_missing: true`
  - `pricing_variables_source: "snapshot_missing_no_live_recalculation"`
- Metadados do snapshot (`snapshot_origin`, `snapshot_quality`, `estimated`) são propagados do `_s7_financial`.

Resultado: sem fallback vivo silencioso em venda histórica.

### 2.2 `productCatalogRow` (P1)

- Removido fallback paralelo de lucro (`revenue - costTotal`) quando backend não envia lucro explícito.
- Removido fallback paralelo de margem (`profit / revenue`).
- Agora margem/lucro para saúde do produto dependem somente de campos canônicos enviados pelo backend.
- Sem dado canônico suficiente, status permanece `unknown` (legítimo SSOT).

Resultado: frontend deixa de operar motor paralelo de margem/lucro.

### 2.3 `summary.js` (P1)

- Migrada agregação monetária de `Number/float` para `Decimal`.
- Somas (`gross`, `net`, `fees`, `shippingFees`) e média (`avgTicket`) agora em Decimal.
- `loss_orders_count` agora avaliado com `net.lt(0)` em Decimal.
- Conversão de saída monetária padronizada por `toMoneyString` com `Decimal`.

Resultado: cálculos monetários sem float, alinhados ao padrão financeiro S7.

## 3) Validacao de sintaxe

Executado:

`node --check suse7-backend/src/domain/sales/loadSaleOrderItemForSeller.js`  
`node --check suse7-backend/src/handlers/sales/summary.js`  
`node --check suse7-frontend/src/utils/productCatalogRow.js`

Status: PASS (sem erro de sintaxe).

## 4) Tabela final (anterior vs novo)

| Área | Status anterior | Status novo | Motivo | Próxima ação |
|---|---|---|---|---|
| Vendas — payload manual (Raio-X/notificação) | FAIL | PASS | Removido fallback vivo de produto/imposto atual em `loadSaleOrderItemForSeller` | Manter auditoria de regressão no próximo ciclo |
| Produtos — saúde/lucro/margem em catálogo | WARNING | PASS | Removido fallback paralelo (`lucro=receita-custo`, `margem=lucro/receita`) | Garantir backend sempre enviar banda/margem canônicas |
| `/api/sales/summary` (agregação monetária) | WARNING | PASS | Migrado para Decimal em todas as somas/médias monetárias | Cobrir com teste unitário de arredondamento |
| Dashboard (área auditável atual) | WARNING | WARNING | Parcialmente auditável no checkout atual | Completar checkout frontend para fechar 100% |
| Notificações (resumo diário, popups, sininho, WhatsApp, e-mail) | FAIL | BLOCKED/P0 | Código-fonte dos handlers/motores não está visível localmente para certificação final | Restaurar checkout completo e reauditar |
| Exportações (Excel, Copy, Print, WhatsApp, E-mail) | FAIL | BLOCKED/P0 | Código-fonte parcial/incompleto no checkout atual | Restaurar checkout completo e reauditar ponta a ponta |

## 5) Conclusão da Fase 2B

- Nenhum ponto **auditável** permanece em FAIL após as correções P1.
- Pontos sem fonte completa visível foram corretamente reclassificados para **BLOCKED/P0** (sem falso PASS).
- Regra de ouro aplicada: venda histórica sem snapshot não usa fallback vivo silencioso.

