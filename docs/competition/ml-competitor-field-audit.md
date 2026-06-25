# S7 — Auditoria de campos ML para concorrentes (anúncios de terceiros)

Auditoria via API oficial (app token `client_credentials`). Script: `scripts/probe_competition_ml_audit.mjs`.

**Restrição principal:** `GET /items/{id}` e multiget `GET /items?ids=` retornam **403 / corpo vazio** para anúncios de terceiros. Dados confiáveis vêm de **catálogo** (`/products/...`) e **perfil do vendedor** (`/users/...`).

## Tabela de disponibilidade

| Informação | Campo ML/API | Disponível? | Fonte | Observação |
| ---------- | ------------ | ----------- | ----- | ---------- |
| Título | `title` | Parcial | `/items/{id}` | Bloqueado (403) para terceiros; usar `name` do catálogo ou slug da URL |
| Título catálogo | `name` | Sim | `/products/{id}` | Nome do produto de catálogo associado |
| Preço | `price` | Sim | `/products/{id}/items` | Row com `item_id` do concorrente → `last_seen_price` |
| Thumbnail item | `secure_thumbnail`, `thumbnail`, `pictures[]` | Parcial | `/items/{id}` | Bloqueado para terceiros |
| Imagem catálogo | `pictures[].secure_url` | Sim | `/products/{id}` | Fallback principal para concorrentes por link |
| Permalink | `permalink` | Parcial | `/items/{id}` | Bloqueado; montar `produto.mercadolivre.com.br/MLB-{id}` ou URL colada |
| Seller ID | `seller_id` | Sim | `/products/{id}/items` row | Também em item próprio via `/items` |
| Nickname loja | `nickname` | Sim | `/users/{seller_id}` | Exibir como `competitor_store_name` |
| Reputação | `seller_reputation.level_id`, `power_seller_status` | Sim | `/users/{seller_id}` | Snapshot `reputation` jsonb |
| Cidade/UF vendedor | `address.city`, `address.state` | Sim | `/users/{seller_id}` | Opcional; não exibido no card S1 |
| Quantidade vendida | `sold_quantity` | Parcial | `/items/{id}` | Bloqueado para terceiros; catálogo row geralmente não traz |
| Tipo anúncio | `listing_type_id` | Sim | `/products/{id}/items` row | Ex.: `gold_special`, `gold_pro` |
| Frete grátis | `shipping.free_shipping` | Sim | `/products/{id}/items` row | Snapshot `shipping` jsonb |
| Logística | `shipping.mode`, `shipping.logistic_type` | Sim | `/products/{id}/items` row | Incluído em `shipping` normalizado |
| Condição | `condition` | Parcial | `/items/{id}` | Bloqueado para terceiros |
| Categoria | `category_id` | Parcial | `/items/{id}` | Bloqueado para terceiros |
| Catálogo ID | `catalog_product_id` | Parcial | `/items/{id}` | Bloqueado; extrair de URL `/p/MLB…` |
| Atributos | `attributes[]` | Sim | `/products/{id}` | Não exibido no card nesta fase |
| Status anúncio | `status` | Parcial | `/items/{id}` | 403 corpo; HTTP status visível |
| Criação/atualização | `date_created`, `last_updated` | Parcial | `/products/{id}` | Metadado catálogo; não no card |

## Estratégia de enrich (Suse7)

1. `GET /items/{id}` → se 200, dados completos (próprio anúncio ou exceção).
2. `GET /items?ids=` → tentativa multiget.
3. `GET /products/{id}/items` — match por `item_id`:
   - direto via `/p/MLB…` no permalink;
   - ou busca `/products/search` + slug da URL.
4. `GET /products/{id}` → `pictures` para thumbnail.
5. `GET /users/{seller_id}` → nickname + reputação.
6. Slug da URL → título visual quando API não entrega.

## Logs DEV

- `[COMPETITION_AUDIT]` — script de auditoria
- `[COMPETITION_ENRICH] image_source` — `item_thumbnail` \| `catalog_product` \| `none`
- `[COMPETITION_ENRICH] price_source` — `catalog_items_row` \| `items_api` \| `none`
- `[COMPETITION_ENRICH] seller_source` — `users_api` \| `catalog_items_row` \| `none`

## Causa histórica — imagem ausente em concorrentes por link

O enrich só consultava catálogo quando **faltava título ou preço**. Com título preenchido via slug da URL, o fluxo **pulava** o catálogo e nunca buscava `pictures` em `/products/{id}`.
