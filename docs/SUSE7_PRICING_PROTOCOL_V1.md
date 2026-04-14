# Suse7 Pricing Protocol v1

**Decisão arquitetural:** [ADR-0001 — Suse7 Pricing Contract v1](adr/ADR-0001-pricing-contract-v1.md).

Documento interno — contrato oficial de preço e repasse unitário na grid de anúncios (`GET /api/ml/listings`).

## 1. Fonte de verdade

| Domínio   | Fonte |
|----------|--------|
| Preço de catálogo / efetivo / promoção | **Backend** (`resolveMercadoLivreListingPricingForGrid` + health/sync ML) |
| Flag de promoção | **Backend** (`promotion_active`) |
| Payout “Você recebe” | **Marketplace**, persistido em `marketplace_listing_health.marketplace_payout_amount` (sem recálculo no frontend) |

## 2. Campos oficiais (cada item em `listings[]`)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `listing_price_brl` | string decimal | Preço de catálogo / original; preenchido sempre que houver dados de preço |
| `promotion_active` | boolean | `true` se promoção válida (resolution **ou** par health **ou** `original_price > price` no item, com tolerância) |
| `promotional_price_brl` | string \| null | Preço promocional; **somente** se `promotion_active === true` |
| `effective_sale_price_brl` | string \| null | Preço usado em **todos** os cálculos de receita/lucro: promo quando ativa, senão lista |
| `marketplace_payout_amount` | string \| null | “Você recebe” oficial |
| `marketplace_payout_source` | enum | `ml_official` \| `estimated` \| `unresolved` |

### Espelhos / legado (não usar como fonte principal)

- `price_brl` — espelho de `effective_sale_price_brl` para clientes antigos
- `net_receive_brl` — espelho de `marketplace_payout_amount`
- `net_receivable` (DB) — legado; **não** usar na UI

Raiz da resposta:

- `pricing_protocol`: `"suse7-pricing-v1"`
- `listing_grid_contract_version`: incremental quando o shape monetário muda

## 3. Regras

1. O **frontend não calcula** preço efetivo nem regra de promoção.
2. O **frontend não recalcula** payout; exibe apenas `marketplace_payout_amount`.
3. Linha / coluna de promoção só aparece se `promotion_active === true` e houver `promotional_price_brl`.
4. `ensureListingGridMoneyContract` garante presença das chaves do protocolo em cada linha.

## 4. Proibições

- Não usar `price_brl` como fonte principal de preço em novas telas
- Não usar `net_receivable` na UI
- Não inferir promoção no frontend
- Não usar `net_proceeds.net_proceeds_amount` como “Você recebe” oficial

## 5. Checklist anti-regressão

1. Produto **sem** promoção: só `listing_price_brl` visível como preço base; `effective_sale_price_brl` alinhado; sem `promotional_price_brl`.
2. Produto **com** promoção: `listing_price_brl` + `promotional_price_brl`; cálculos com `effective_sale_price_brl`.
3. Produto **saindo** da promoção: `promotion_active` false; promo some da UI.
4. Payout **consistente** entre coluna grid, Raio-x e `marketplace_payout_amount`.

## 6. Implementação de referência

- Resolver: `src/handlers/ml/_helpers/marketplaces/mercadoLivreListingGrid.js` — `resolveMercadoLivreListingPricingForGrid`
- Contrato da resposta: `src/handlers/ml/_helpers/listingGridAssembler.js` — `ensureListingGridMoneyContract`, `LISTING_GRID_MONEY_CONTRACT_VERSION`
- Rota: `src/handlers/ml/listingsList.js`
