# Auditoria Forense — Raio-X do Anúncio (Vendas)

## Escopo auditado

- Anúncio: `MLB6086562408`
- SKU: `11011`
- Conta: `be36ef3e-cd3b-4b94-b071-4eb583ee4fce`
- Seller: `c8a62ec6-cfbe-4ad9-98ea-49fadebeda50`

## Origem do número do card "Vendas" (antes da correção)

Fluxo rastreado:

1. `ListingRayXModal` consome `useListingFinancialRayX`.
2. `useListingFinancialRayX` chama `/api/sales/executive-summary` com `q=<listing_id>`.
3. `ProductFinancialRayXPanel` exibia o card "Vendas" priorizando `summary.items_quantity_sold` (unidades), com fallback para `summary.orders_count`.

Conclusão:

- O card "Vendas" não vinha de `listing_sales_metrics`.
- O card "Vendas" não vinha de `marketplace_listings.sold_quantity`.
- O card vinha de agregação do `executive-summary` (backend), com render no frontend.
- Antes da correção, estava representando **unidades vendidas**, não **pedidos**.

## Verificação de fontes candidatas

- `sales_orders`/`sales_order_items`: **SIM** (fonte real da agregação executiva)
- `listing_sales_metrics`: **NÃO** (sem linha para este caso na conta auditada)
- `marketplace_listings`: **NÃO** para o card de Vendas (apenas dado oficial do anúncio)
- `sold_quantity/initial_quantity/available_quantity` do ML: **NÃO** para o card de Vendas
- cálculo agregado frontend/backend: **SIM** (cálculo agregado no backend + exibição frontend)

## Evidência de dados (ambiente auditado)

### Mercado Livre (snapshot de listagem no banco)

- `marketplace_listings.sold_quantity`: **159**
- `initial_quantity`: **217**
- `available_quantity`: **58**

### SUS7 importado (vendas históricas encontradas)

- `sales_order_items` para o anúncio: **160 linhas**
- pedidos distintos (`COUNT DISTINCT sales_order_id`): **159**
- unidades vendidas (`SUM quantity`): **160**
- período coberto (`date_created_marketplace`): **2025-12-31T14:05:11Z** até **2026-05-25T20:51:33Z**

### SUS7 no executive-summary

- Sem período explícito (preset default `60d`): `orders_count=13`, `items_quantity_sold=13`
- Com `period_preset=lifetime`: `orders_count=159`, `items_quantity_sold=160`

## Leitura final da divergência de contagem

- Diferenças do tipo "ML total maior que SUS7 no card" podem acontecer por:
  1) **Janela de período** (default `60d` vs histórico importado),
  2) **semântica do número** (unidades vs pedidos),
  3) **escopo do dado** (total histórico oficial da listagem no ML vs vendas efetivamente importadas no SUS7).

- Para este anúncio/conta auditados, o total importado já está alto (159 pedidos / 160 unidades), então a divergência vista em outras homologações (ex.: 77 vs 32) não se reproduziu neste snapshot específico.
