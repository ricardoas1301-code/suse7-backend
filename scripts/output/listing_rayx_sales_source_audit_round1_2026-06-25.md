# Homologação Visual — Motor Verdade Única (Rodada 1)

## Caso auditado

- Listing: `MLB6086602390`
- SKU: `11011`
- Seller: `c8a62ec6-cfbe-4ad9-98ea-49fadebeda50`
- Conta: `be36ef3e-cd3b-4b94-b071-4eb583ee4fce`

## Fontes auditadas

- `sales_orders` / `sales_order_items` (importado SUS7)
- `summary.orders_count` do `/api/sales/executive-summary`
- `summary.items_quantity_sold` do `/api/sales/executive-summary`
- `marketplace_listings.sold_quantity`
- `listing_sales_metrics` (quando existir)

## Resultado forense

- `listing_sales_metrics`: **não existe linha** para este listing/conta no snapshot auditado.
- SUS7 importado:
  - `orders_count_distinct`: **75**
  - `units_sold_sum`: **76**
  - período importado: **2026-01-05T19:12:04Z** até **2026-06-25T15:57:54Z**
- Executive summary:
  - período `60d`: `orders_count=31`, `items_quantity_sold=32`
  - período `lifetime`: `orders_count=75`, `items_quantity_sold=76`
- `marketplace_listings.sold_quantity` no snapshot atual do banco: **70**

## Causa da divergência 75 vs 76

- **75** representa pedidos (`orders_count`).
- **76** representa unidades vendidas (`items_quantity_sold`).
- A diferença é semântica (pedido vs unidade), não erro de soma.

## Nota sobre “ML mostra 77”

- No snapshot técnico auditado agora, o campo oficial persistido em `marketplace_listings.sold_quantity` está em **70**.
- Se a UI do ML mostra **77** no momento da homologação visual, isso indica divergência temporal/fonte (dados oficiais ao vivo no ML vs snapshot persistido/importado no SUS7 naquele instante).
