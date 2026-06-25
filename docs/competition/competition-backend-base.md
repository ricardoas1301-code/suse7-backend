# S7 — Concorrência Inteligente: Backend Base (Fase S1)

> Status: **implementado** (CRUD base + **descoberta real Mercado Livre**).
> A descoberta retorna candidatos para o seller escolher — **nada é salvo nem vira snapshot** nesta fase.

Referências:

- `docs/competition/mercado-livre-discovery.md` (estratégias e dados mínimos)
- `docs/competition/competition-database-model.md` (modelo de dados)
- migration `supabase/migrations/20260608154500_create_competition_tables.sql`

## Arquitetura

Camadas modulares (handler fino, dados no repository, contrato no normalizer):

- `api/index.js` → delega todo `/api/competition/*` para o handler.
- `src/handlers/competition/index.js` → roteamento interno por método/path, validação e orquestração.
- `src/domain/competition/competitionRepository.js` → todas as queries Supabase + ownership.
- `src/domain/competition/competitionNormalizer.js` → normalização de entrada e **contrato único** de saída.

Autenticação: `requireAuthUser(req)` (service role; **bypassa RLS**). Por isso o ownership é
sempre filtrado por `user_id` explicitamente no repository.

## Regra oficial — SKU vs busca de concorrente

- O **SKU interno do Suse7** localiza o **produto do seller** (`products.id` / `products.sku`).
- O concorrente quase nunca tem o mesmo SKU. A **descoberta** de concorrentes deve usar:
  **nome / palavras-chave / título do anúncio / categoria / marca / GTIN-EAN / catálogo ML**
  (`catalog_product_id` quando existir). Nunca o SKU do seller como chave de busca.

## Endpoints

Todos exigem `Authorization: Bearer <access_token>`.

### GET `/api/competition/products`

Lista produtos do usuário com contagem de concorrentes ativos.

```json
{
  "ok": true,
  "products": [
    {
      "product_id": "uuid",
      "sku": "ABC-123",
      "product_name": "Produto Exemplo",
      "image_url": null,
      "marketplace": "mercado_livre",
      "competitors_count": 3,
      "has_competitors": true
    }
  ]
}
```

> `image_url` fica `null` nesta fase; a capa é resolvida no frontend (signed URL).
> `competitors_count` vem de `competition_competitors` com `is_active = true`.

### GET `/api/competition/products/:productId/competitors`

Lista concorrentes ativos de um produto (valida ownership do produto).

```json
{
  "ok": true,
  "product": { "product_id": "uuid", "sku": "ABC-123", "product_name": "Produto Exemplo" },
  "competitors": [ /* contrato de concorrente (abaixo) */ ],
  "competitors_count": 3
}
```

### POST `/api/competition/products/:productId/competitors`

Cria **ou reativa** um concorrente monitorado.

Request:

```json
{
  "marketplace": "mercado_livre",
  "marketplace_account_id": "uuid|null",
  "seller_company_id": "uuid|null",
  "sku": "ABC-123",
  "competitor_listing_id": "MLB123",
  "competitor_title": "Produto concorrente",
  "competitor_seller_id": "123456",
  "competitor_store_name": "Loja Exemplo",
  "competitor_permalink": "https://...",
  "competitor_thumbnail": "https://...",
  "source_strategy": "manual_placeholder",
  "last_seen_price": "129.90",
  "last_seen_currency": "BRL"
}
```

Regras:

- valida que `product_id` pertence ao `user_id` (404 se não);
- `competitor_listing_id` é obrigatório (400 se ausente);
- limite de **9 concorrentes ativos** por `(user_id, marketplace, product_id)` — imposto por trigger
  no banco; o handler devolve **409 `ACTIVE_LIMIT_REACHED`**;
- evita duplicidade pelo unique parcial (`is_active = true`);
- se já existir o mesmo anúncio concorrente **inativo**, **reativa** (`reactivated: true`);
- se já existir **ativo**, atualiza os dados principais sem duplicar;
- preço é normalizado para string numeric-safe (decimal.js, nunca float). Quando há preço,
  grava `last_captured_at = now()`.

Response: `201` (novo) ou `200` (reativado/atualizado):

```json
{ "ok": true, "reactivated": false, "competitor": { /* contrato */ } }
```

### DELETE `/api/competition/competitors/:competitorId`

**Soft-delete**: `is_active = false`. Nunca apaga fisicamente (preserva snapshots).
Valida ownership por `user_id`. Idempotente (já inativo → `already_inactive: true`).

```json
{ "ok": true, "competitor": { /* contrato */ }, "message": "Concorrente desativado (histórico preservado)." }
```

### POST `/api/competition/products/:productId/discover` — **descoberta real (Mercado Livre)**

Descobre concorrentes reais para o seller **escolher** (nada é salvo aqui).

Request (`query` é opcional — o backend monta a query a partir do anúncio/produto):

```json
{ "query": "opcional", "marketplace": "mercado_livre", "marketplace_account_id": null, "seller_company_id": null, "limit": 20 }
```

Fluxo:

1. valida ownership do produto;
2. carrega o anúncio do seller vinculado (`catalog_product_id`, `category_id`, título, atributos `BRAND`/`GTIN`, conta);
3. resolve o token ML via `getValidMLToken(userId, { marketplaceAccountId })`;
4. executa o `CompetitionEngine` (catálogo → fallback busca pública);
5. retorna candidatos normalizados.

**Estratégia / fallback (`CompetitionEngine`):**

- **`ml_catalog`** (Fluxo A): se houver `catalog_product_id` → `GET /items/{id}/price_to_win?version=v2` (contexto), `GET /products/{catalog_product_id}/items` (lista), detalha via multiget `GET /items?ids=`.
- **`ml_search`** (Fluxo B): fallback quando catálogo vazio/indisponível → `GET /sites/MLB/search`. Query: **GTIN > título > nome do produto** + categoria. **Nunca o SKU do seller.**
- catálogo vazio → busca pública; busca vazia → `results: []` (nunca erro).

Em todos os casos: remove o **próprio anúncio/seller** e **deduplica** por `competitor_listing_id`.

**Resposta (contrato único — catálogo e busca compartilham o mesmo shape):**

```json
{
  "ok": true,
  "success": true,
  "strategy": "ml_catalog",
  "total": 6,
  "results": [
    {
      "competitor_listing_id": "MLB123",
      "competitor_title": "Produto concorrente",
      "competitor_store_name": "Loja Exemplo",
      "competitor_seller_id": "123456",
      "competitor_price": "129.90",
      "currency": "BRL",
      "competitor_permalink": "https://...",
      "competitor_thumbnail": "https://...",
      "shipping": { "free_shipping": true, "mode": "me2", "logistic_type": "fulfillment" },
      "listing_type": "gold_special",
      "reputation": { "level_id": null, "power_seller_status": null },
      "source_strategy": "ml_catalog"
    }
  ]
}
```

> Conta ML não conectada → `200` com `success: true, total: 0, results: [], warning: "ml_token_unavailable"` (degrada, não quebra).
> O frontend **não** precisa saber qual estratégia foi usada — só consome `results`.

**Módulos da descoberta:**

- `src/domain/competition/CompetitionEngine.js` — resolver + fallback (registry por marketplace; pronto p/ Shopee/Amazon/Shein).
- `src/domain/competition/CompetitionDiscoveryStrategy.js` — contrato base (Strategy Pattern).
- `src/domain/competition/strategies/MercadoLivreCatalogCompetitionStrategy.js` — Fluxo A (catálogo).
- `src/domain/competition/strategies/MercadoLivreSearchCompetitionStrategy.js` — Fluxo B (busca pública).
- `src/domain/competition/strategies/mlCompetitorMapping.js` — mapeamento item ML → candidato + extração brand/GTIN + exclusão do próprio anúncio.
- `src/handlers/ml/_helpers/mercadoLibreItemsApi.js` — helpers ML reutilizáveis: `fetchItemPriceToWin`, `fetchCatalogProduct`, `fetchCatalogProductItems`, `searchMarketplaceListings`.

**Observabilidade:** logs com prefixo `[COMPETITION]` (`Product loaded`, `Strategy selected`, `Catalog competitors found`, `Search competitors found`, `Candidates normalized`). Nunca loga token/dados sensíveis.

## Contrato único de concorrente

Mesmo shape em list/create/reactivate (e base para snapshots futuros):

```json
{
  "id": "uuid",
  "marketplace": "mercado_livre",
  "product_id": "uuid",
  "sku": "ABC-123",
  "competitor_listing_id": "MLB123",
  "competitor_title": "Produto concorrente",
  "competitor_seller_id": "123456",
  "competitor_store_name": "Loja Exemplo",
  "competitor_permalink": "https://...",
  "competitor_thumbnail": "https://...",
  "source_strategy": "manual_placeholder",
  "is_active": true,
  "last_seen_price": "129.90",
  "last_seen_currency": "BRL",
  "last_captured_at": null
}
```

`last_seen_price` sempre como **string** `"129.90"` (ou `null`) — evita ambiguidade de float no front.

## Multi-tenant / segurança

- Multi-user, multi-CNPJ (`seller_company_id`) e multi-conta marketplace (`marketplace_account_id`).
- Ownership de **produto** e de **concorrente** validado por `user_id` em toda operação.
- Sem token hardcoded; sem exposição de credenciais.
- Desativar ≠ deletar: snapshots (`competition_snapshots`) ficam preservados.

## Frontend

`suse7-frontend/src/services/competitionApi.js` foi alinhado a estes endpoints
(`competitionListProducts`, `competitionListCompetitors`, `competitionCreateCompetitor`,
`competitionDeactivateCompetitor`, `competitionDiscover`). A tela `ConcorrenciaPage.jsx`
segue com placeholder local até a fase de integração da UI.

## Próximos passos

- Conectar `ConcorrenciaPage.jsx` ao backend: exibir candidatos da descoberta para o seller **selecionar** e cadastrar (POST competitors).
- Persistir `competition_snapshots` a cada captura de preço/posição (histórico).
- Enriquecer concorrente (nickname/reputação via `/users/{seller_id}`) no momento da seleção.
- Captura agendada (cron/janelas) + cache/backoff de rate limit — fora desta fase.
- Integração com a aba Concorrentes da Precificação Inteligente.
