# Concorrência — Fluxo de Seleção e Cadastro (Fase S1)

Documenta o fluxo visual + backend que conecta a página **Concorrência** ao backend real
(`/api/competition/*`), permitindo ao seller buscar concorrentes reais no Mercado Livre,
cadastrar até 6 por produto e removê-los (soft-delete).

> Esta fase **não** cria snapshots automáticos nem cron. Apenas seleção e cadastro manual.

> **Escopo fechado:** esta trilha finaliza **somente a página Concorrência** (lista + modal).
> A **aba Concorrência da Precificação Inteligente** será feita em outra trilha — nada em
> `PricingIntelligenceContent`, `PricingIntelligenceWorkspaceTabs`, aba Promoções, cards/gráficos
> de precificação ou `/precificacoes/inteligente` é alterado aqui.

## Visão geral do fluxo visual

1. **Lista principal** (`ConcorrenciaPage.jsx`)
   - Carrega os produtos do seller (Supabase) para capa/nome/SKU.
   - Faz **1 chamada** a `listCompetitionProducts()` (`GET /api/competition/products`) para
     obter, por produto: contagem real de concorrentes ativos + projeção compacta dos
     concorrentes (preço/loja/canal) usada nas 6 colunas.
   - Chips **Todos / Com concorrentes / Sem concorrentes** operam sobre a contagem real.
   - Cada linha abre o modal de gestão.

2. **Modal de gestão** (`ConcorrenciaProdutoModal.jsx`) — 3 áreas:
   - **Área 1 — Produto selecionado:** capa, nome, SKU, canal (Mercado Livre) e contador `N/6`.
   - **Área 2 — Concorrentes cadastrados:** até 6 cards (thumbnail, título, preço, loja, link
     "Ver anúncio") com botões **Alterar** e **Remover**. Estado vazio: _"Nenhum concorrente
     cadastrado ainda."_
   - **Área 3 — Buscar concorrentes:** campo de busca (valor inicial = nome do produto, editável)
     + botão **Buscar no Mercado Livre**. Lista os candidatos do `/discover` com **Cadastrar** /
     **Já cadastrado** / **Ver anúncio**.

3. Após cadastrar/remover, o modal recarrega os concorrentes e dispara `onChanged()`, que
   refaz `listCompetitionProducts()` para atualizar contagem e colunas da lista principal.

## Endpoints usados

| Ação | Método / rota | Service (`competitionApi.js`) |
|---|---|---|
| Lista de produtos + contagem/concorrentes | `GET /api/competition/products` | `listCompetitionProducts()` |
| Concorrentes ativos do produto | `GET /api/competition/products/:productId/competitors` | `listProductCompetitors(productId)` |
| Descoberta real Mercado Livre | `POST /api/competition/products/:productId/discover` | `discoverProductCompetitors(productId, { query, marketplace, limit })` |
| Cadastrar/reativar concorrente | `POST /api/competition/products/:productId/competitors` | `saveProductCompetitor(productId, payload)` |
| Remover (soft-delete) | `DELETE /api/competition/competitors/:competitorId` | `removeProductCompetitor(competitorId)` |
| Capturar snapshot (histórico on-demand) | `POST /api/competition/products/:productId/snapshot` | `snapshotProductCompetitors(productId)` |

### Payload de cadastro (contrato atual)

```jsonc
{
  "marketplace": "mercado_livre",
  "sku": "<sku interno do produto>",
  "competitor_listing_id": "MLB123...",
  "competitor_title": "Título do anúncio concorrente",
  "competitor_seller_id": "987654",
  "competitor_store_name": "Loja XPTO",
  "competitor_permalink": "https://...",
  "competitor_thumbnail": "https://...",
  "source_strategy": "ml_catalog | ml_search | manual_placeholder",
  "last_seen_price": "129.90",
  "last_seen_currency": "BRL"
  // marketplace_account_id / seller_company_id são opcionais:
  // quando ausentes, o backend os completa a partir do anúncio interno do produto (multi-CNPJ).
}
```

## Limite funcional de 6

- Regra de produto **nesta fase: 6 concorrentes ativos por produto**.
- O banco continua com limite físico **9** (trigger `s7_competition_enforce_active_limit`),
  **sem migration nesta fase**.
- Validação em camadas:
  - **Frontend:** desabilita "Cadastrar" e mostra aviso quando `ativos >= 6`.
  - **Backend (`postProductCompetitor`):** quando a operação cria um novo ativo (registro novo
    ou reativação de inativo), conta os ativos e bloqueia em `>= 6` com
    `409 { code: "ACTIVE_LIMIT_REACHED", error: "Limite de 6 concorrentes ativos por produto atingido." }`.
  - Atualizar um concorrente **já ativo** não conta para o limite.

## Remover vs. apagar

- **Remover = soft-delete:** `DELETE` marca `is_active = false` (preserva histórico e snapshots
  futuros). O concorrente some da lista visual e libera vaga para outro.
- **Não há apagar físico** nesta fase. Recadastrar o mesmo `competitor_listing_id` **reativa** o
  registro existente (idempotente).

## Regra de alteração ("Alterar")

- Não há edição manual de preço/título (evita dado falso — o concorrente real vem do Mercado Livre).
- O botão **Alterar** instrui o seller a **buscar e cadastrar o novo concorrente** e depois
  **remover o atual** (fluxo "remover + cadastrar novo"). Ele foca a área de busca.

## SKU interno vs. busca por palavras-chave

- O **SKU localiza o PRODUTO interno** do seller (chave de ownership/produto).
- A **busca de concorrente nunca usa o SKU do seller** como chave principal. Usa
  nome/palavras-chave/título/categoria/marca/GTIN/EAN ou catálogo Mercado Livre
  (ver `mercado-libre-discovery.md`). A `query` do modal inicia com o nome do produto.

## Busca por palavra-chave (`MercadoLivreSearchCompetitionStrategy`)

> **Importante (root cause histórico do "nenhum candidato"):** o endpoint público
> `GET /sites/$SITE/search` foi **DESCONTINUADO** pelo Mercado Livre — responde
> **403 forbidden** mesmo com token válido. Não há substituto direto para a busca site-wide.

A busca "como comprador" por palavra-chave passou a usar o **buscador de catálogo**:

1. `GET /products/search?status=active&site_id=MLB&q={termo}` → produtos de catálogo (funciona).
2. `GET /products/{product_id}/items` → anúncios concorrentes de cada produto (token do seller).
3. `GET /items?ids=...` → detalhe (preço/loja/thumb/permalink/shipping) e normalização.

Tentativas **progressivas** (para na 1ª com candidatos), sem exigir categoria/catálogo:

1. **GTIN/EAN** (`product_identifier`), se houver e não houver query manual;
2. query completa;
3. query **reduzida** (primeiras palavras significativas — ex.: 4 e 3 termos);
4. query reduzida **sem termos genéricos** (ex.: "moderna", "luxo", "kit").

Prioridade da `query`: **manual do seller > GTIN/EAN > título do anúncio > nome do produto >
fallback curto sanitizado**. O **SKU do seller nunca** é chave de busca (só localiza o produto interno).

### Validação local (token de app via `client_credentials`)

`node scripts/probe_ml_products_search.mjs` (não imprime token) confirmou em DEV:

| termo | /sites/MLB/search | /products/search |
|---|---|---|
| escorredor | 403 forbidden | 200 · 5 produtos |
| escorredor de louça | 403 | 200 · 5 |
| escorredor para pia | 403 | 200 · 5 |
| cuba banheiro | 403 | 200 · 5 |
| kit placas mdf | 403 | 200 · 5 |

Os anúncios por produto (`/products/{id}/items`) exigem **token de usuário** do seller (o token de
app retorna 404/`buy_box_winner` nulo) — em runtime o `getValidMLToken` fornece o token do seller.

### Normalização (não descartar candidatos válidos)

- **Mínimo obrigatório:** `competitor_listing_id`. Título e preço são preservados quando existem
  e nunca derrubam o candidato.
- Campos opcionais podem ser nulos: `thumbnail`, `competitor_store_name`, `reputation`,
  `sales_hint`, `competitor_permalink`, `listing_type`.

### Debug seguro de descoberta

Quando `/discover` retorna vazio, a resposta inclui `warning` e — **apenas em DEV ou com a flag
`S7_COMPETITION_DEBUG=1`** — um bloco `debug` (sem token, sem payload sensível):

```json
{
  "success": true,
  "total": 0,
  "results": [],
  "warning": "no_candidates_found",
  "debug": {
    "strategy_attempted": ["ml_catalog", "ml_search"],
    "search_queries_attempted": ["...", "cuba banheiro"],
    "raw_results_count": 0,
    "normalized_results_count": 0,
    "warning": "no_candidates_found",
    "last_error": null
  }
}
```

Logs de diagnóstico: backend usa prefixo `[COMPETITION]`; frontend usa `[COMPETITION_UI]` (somente
em DEV). **Nunca** logam token.

## Multi-marketplace / multi-CNPJ / ownership

- Todas as queries filtram por `user_id` (ownership) — RLS + filtro explícito no repository.
- `marketplace` é mantido por linha (preparado para Shopee/Amazon/Shein no futuro).
- `marketplace_account_id` / `seller_company_id` são completados a partir do anúncio interno do
  produto quando não enviados, preservando multi-CNPJ e múltiplas contas.

## Snapshot e histórico (on-demand — fase atual)

Captura **manual** dos dados atuais dos concorrentes ativos, gravando histórico imutável.

- **Endpoint:** `POST /api/competition/products/:productId/snapshot`
- **Serviço:** `src/domain/competition/competitionSnapshotService.js` → `captureCompetitorsSnapshot()`
- **Botão no modal:** _"Atualizar concorrentes"_ (Área 2; só aparece com concorrentes cadastrados).

### Fluxo

1. Valida ownership do produto e lista concorrentes ativos.
2. Sem concorrentes → `{ success: true, captured_count: 0, empty: true }` (não é erro).
3. Resolve token ML com `getValidMLToken` (conta do anúncio vinculado; fallback p/ conta do
   concorrente). Sem token → `warning: "ml_token_unavailable"`, `captured_count: 0`.
4. Busca dados atuais via `fetchItemsByIds` (multiget público em chunks de 20; ignora não-200).
5. Para cada concorrente:
   - **item retornado** → normaliza (`mlItemBodyToCandidateRaw` + `sold_quantity` → `sales_hint`),
     grava 1 linha em `competition_snapshots` (append-only, preço como string numeric-safe), e
     atualiza os campos **atuais** em `competition_competitors`
     (`last_seen_price`/`last_seen_currency`/`last_captured_at`).
   - **item ausente/pausado/erro** → fallback gracioso: conta em `failed_count`, sem snapshot.
6. Token nunca é logado.

### Contrato de resposta

```json
{
  "success": true,
  "product_id": "uuid",
  "captured_count": 4,
  "failed_count": 0,
  "snapshots": []
}
```

### Regras do snapshot

- `competition_snapshots` é **append-only** (sem update/delete; RLS sem policy de UPDATE/DELETE).
- Em `competition_competitors` só os campos **atuais** são tocados — preço só é sobrescrito quando
  há valor válido (não apaga o último preço conhecido).
- Sem recálculo financeiro; preço sempre via `Decimal`/string.
- Sem cron nesta fase (a captura é disparada pelo seller).

## Próximos passos (monitoramento automático)

- Job/cron de captura periódica por concorrente ativo (reaproveita `captureCompetitorsSnapshot`).
- Gráficos históricos de preço/posição a partir de `competition_snapshots`.
- Alimentar a Precificação Inteligente com a série histórica (price-to-win, faixa de mercado).
