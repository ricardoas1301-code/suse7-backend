# Fonte da verdade — financeiro Raio-X da venda (Mercado Livre)

Documento técnico do contrato `sales_order_items.raw_json._s7_financial` (snapshot `ml_financial_v2`).
O frontend **não calcula** dinheiro; apenas lê o contrato persistido via `GET /api/sales/detail`.

## Endpoints oficiais (enrichment)

| Endpoint | Uso |
|----------|-----|
| `GET /orders/:id` | Pedido, linhas, `sale_fee`, preços, pagamentos |
| `GET /orders/:id/discounts` | Subsídios e descontos (com filtros — ver proibições) |
| `GET /shipments/:id` | Custo de envio do seller (`list_cost - cost`) |

Refresh DEV:

- `POST /api/dev/sales/:sale_id/refresh-financial-contract`
- Script: `node scripts/audit_ml_sale_financial_source_of_truth.mjs --refresh`
- Script unitário: `node scripts/refresh_sale_by_external_order.mjs <external_order_id>`

## Prioridade por linha do modal

### 1. Valor da venda (`gross_sale_amount_brl`)

| Prioridade | Fonte | Campo |
|------------|--------|--------|
| 1 | Order line | `line.unit_price` × `quantity` (ou `line.total_amount`) |
| 2 | Order | `order.total_amount` (single line) |

**Proibido:** `gross_price` do anúncio como preço da venda (é preço de catálogo em promo).

### 2. Tarifa / comissão (`marketplace_fee.amount_brl`)

| Prioridade | Fonte | Campo |
|------------|--------|--------|
| 1 | Enrichment + contrato | `buildMercadoLivreMarketplaceFeeContract` após fórmula v2 |
| 2 | Order line | `line.sale_fee` **× qty** quando `sale_fee` for por unidade |
| 3 | Payments | `payments[].marketplace_fee` (proporcional se multi-line) |
| 4 | Promo matcher | Taxa catálogo × preço da venda quando `gross_price > unit_price` |
| 5 | Fallback | `listing_type` default — **somente** com `is_estimated: true` |

**Proibido como tarifa bruta do painel:**

- `line.sale_fee` unitário sem multiplicar por `quantity` em pedidos multi-unidade
- Percentual inferido só de `listing_type` quando existe tarifa real na API

**Decimal:** `ROUND_HALF_UP` em valores monetários; percentual exibido 1 casa (`calculateEffectiveMarketplaceFeePercentage`).

### 3. Envios (`shipping_amount_brl`)

| Prioridade | Fonte | Campo |
|------------|--------|--------|
| 1 | Shipment API | `shipping_option.list_cost - shipping_option.cost` |
| 2 | Shipment | `base_cost` se plausível |

**Proibido:** usar desconto de frete da discounts API nesta linha.

### 4. Descontos e bônus (`marketplace_rebate`)

Resolver: `resolveMercadoLivreMarketplaceRebate` (`src/domain/sales/mercadoLivreMarketplaceRebate.js`).

| Prioridade | Fonte | Regra |
|------------|--------|--------|
| 1 | Tarifa explícita | `fee_gross - line.sale_fee` (líquido na API) **somente** se `fee_gross > line.sale_fee` e diferença ≥ R$ 0,01 |
| 2 | `sale_fee_details` | Ajuste positivo coerente com split tarifa |
| 3 | Discounts API | `funding_mode: sale_fee` **somente** se confirmar subsídio de tarifa (não desconto de preço) |

**Proibido:**

- Somar cupons / `funding_mode` vazio / `seller` da discounts API como rebate
- Rebate residual para “fechar conta”
- Exibir rebate quando `fee_gross ≈ line.sale_fee` (painel ML sem “Estorno”)

`confidence` deve ser `"explicit"` para o frontend exibir a linha.

### 5. Valor recebido (`net_received_amount_brl`)

```
net = gross_sale - marketplace_fee_gross - shipping + marketplace_rebate
```

Somente com snapshot completo (`snapshot_complete: true`, versão `ml_financial_v2`).

## Persistência

- Tabela: `sales_order_items.raw_json._s7_financial`
- Versão: `ml_financial_v2`
- Campos legados espelhados: `marketplace_fee_amount_brl`, `positive_adjustments_brl`, `fee_amount` (coluna)

## Auditoria — 6 pedidos (DEV, refresh 2026-05-20)

IDs no painel ML vs Supabase DEV (atenção ao dígito `65` vs `85`):

| Painel ML (informado) | `external_order_id` no banco DEV |
|----------------------|----------------------------------|
| 2000018523593692 | 2000016523593692 |
| 2000018522414612 | 2000016522414612 |
| 2000018521633060 | 2000016521263060 |
| 2000018577460216 | 2000016517460216 |
| 2000018521985682 | 2000016521985682 |
| 2000016504327334 | 2000016504327334 |

### Tabela comparativa pós-refresh (fix `sale_fee × qty`, 2026-05-20)

| Pedido (painel) | ML tarifa | S7 tarifa | ML rebate | S7 rebate | ML net | S7 net | Status |
|-----------------|-----------|-----------|-----------|-----------|--------|--------|--------|
| …523593692 | 78,21 | 78,21 | — | — | 397,14 | 397,14 | **BATE** (`line.sale_fee_x_qty`) |
| …522414612 | 54,07 | 54,07 | — | — | 271,48 | 271,48 | BATE |
| …521633060 | 17,44 | 17,44 | 5,20 | 5,20 | 76,39 | 76,39 | **BATE** (promo 16,5% × venda + estorno) |
| …577460216 | 11,32 | 11,32 | 2,12 | 2,12 | 49,47 | 49,47 | BATE |
| …521985682 | 18,13 | 18,13 | — | — | 75,62 | 75,62 | BATE |
| …504327334 | 21,06 | 21,06 | — | — | 76,09 | 76,09 | BATE |

### Diagnóstico dos divergentes

#### 2000016523593692 (painel …8523593692)

- **Venda:** 3 × R$ 186,20 = R$ 558,60 — OK
- **API:** `line.sale_fee` = **26,07 por unidade**; `line.sale_fee × 3` = **78,21** (= tarifa painel)
- **Erro S7:** contrato usou **30,72** (promo matcher / tarifa errada), não 78,21
- **Rebate 4,65:** artefato de `30,72 - 26,07` — painel **não** tem estorno → não deve exibir
- **Próximo ajuste:** priorizar `line.sale_fee × quantity` como tarifa bruta quando qty > 1; não aceitar promo matcher abaixo do total de `sale_fee`

#### 2000016521263060 (painel …8521633060)

- **Venda:** R$ 105,72 — OK
- **API:** `line.sale_fee` = 6,12; tarifa painel 17,44; venda promocional (`gross_price > unit_price`)
- **Erro S7:** tarifa 7,14 e rebate 1,02 (split incorreto / promo matcher)
- **Painel:** estorno **5,20**; S7 **1,02** — rebate subdimensionado
- **Próximo ajuste:** mesmo eixo Edson/Marcio — tarifa bruta por taxa catálogo × preço da venda + estorno = gross fee − `line.sale_fee` total (validar qty)

## Logs de auditoria

| Tag | Conteúdo |
|-----|----------|
| `[S7 RAYX FINANCIAL AUDIT]` | Script `audit_ml_sale_financial_source_of_truth.mjs` |
| `[S7 RAYX REBATE RESOLVE]` | Aceite/rejeição de rebate |
| `[S7 RAYX ML ENRICHMENT]` | Refresh com token |
| `[S7 RAYX REAL FEE REFRESH]` | Atualização de contrato |

## Multi-marketplace

Implementação atual: resolver ML em `src/domain/sales/mercadoLivre*.js`.
Shopee / Amazon / Shein: espelhar padrão `Strategy` + snapshot version por marketplace, sem reutilizar discounts ML genericamente.

## Recomendação objetiva (sem alterar regra nesta missão)

1. **Corrigir tarifa multi-quantidade:** `sale_fee` per-unit × `qty` antes do promo matcher
2. **Revalidar promo matcher** quando `sale_fee × qty` já bate tarifa do painel (14% de 558,60)
3. **Rebate:** só após tarifa bruta correta; rejeitar split quando `fee_gross` veio de matcher errado
4. Rodar `audit_ml_sale_financial_source_of_truth.mjs --refresh` após fix nos 2 divergentes

Nenhuma mudança de layout ou frontend é necessária para esta fase.
