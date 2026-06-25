# S7 — Concorrência: auditoria de campos para card de concorrente

**Fase:** auditoria técnica (sem alteração de layout/card)  
**Data:** 2026-06-09  
**Escopo:** Mercado Livre — fluxos busca por nome, link, item, seller, catálogo/discovery, snapshot/update  
**Código de referência:** `suse7-backend/src/domain/competition/*`, `ConcorrenciaProdutoModal.jsx`

---

## 1. Resumo executivo

O card de concorrente no Suse7 consome um **contrato unificado** (`toCompetitorResponse` / candidato discover) montado a partir de várias fontes ML. Os fluxos **não são simétricos**:

| Fluxo | Ponto forte | Ponto fraco típico |
|-------|-------------|-------------------|
| **Busca por nome** (`MercadoLivreSearchCompetitionStrategy`, modo broad) | Frete e tipo via `/products/{id}/items`; preço/thumb/título estáveis | Reputação rara no preview; loja só nos top 30 com `/items` |
| **Cadastro por link** (`competitionLinkCandidateResolver` + `competitionListingEnricher`) | `item_id` + permalink confiáveis; completion via discovery | `/items` de terceiros pode 403; meta depende de completion + enrich |
| **Enrich** (`enrichCompetitorListing`) | Pipeline completo: item → catálogo → `/users` | Latência; 403 em item de concorrente |
| **Snapshot / Atualizar** (`captureCompetitorsSnapshot`) | Persiste meta histórica; re-tenta enrich + discovery | Igual limitações de token/permissão ML |

**Regra de ouro:** não bloquear card por ausência de meta (frete, tipo, reputação). Exibir quando existir; marcar `enrich_status: partial` quando faltar.

---

## 2. Arquitetura de dados (persistência)

### 2.1 `competition_competitors` (campos “vivos” do card)

| Coluna DB | Origem API / domínio | Uso no card |
|-----------|----------------------|-------------|
| `competitor_listing_id` | `id` / `item_id` | Identidade; dedup; link MLB |
| `competitor_title` | `title` | Título (link) |
| `competitor_permalink` | `permalink` | URL do anúncio |
| `competitor_thumbnail` | `thumbnail` / `secure_thumbnail` / `pictures` | Imagem |
| `last_seen_price` | `price` | Preço exibido |
| `last_seen_currency` | `currency_id` | Moeda (default BRL) |
| `competitor_store_name` | `seller.nickname` / `/users` | Loja |
| `competitor_seller_id` | `seller_id` / `seller.id` | Chave seller (não exibido hoje) |
| `last_captured_at` | Suse7 (timestamp coleta) | “Atualizado em …” |
| `source_strategy` | Suse7 | `ml_broad_search`, `ml_link`, etc. |
| `enrich_status`* | Calculado na API | `complete` / `partial` / `failed` |

\* `enrich_status`, `enrich_missing_fields`, `last_enrich_error` **não são colunas DB** — calculados em `computeEnrichStatus` + último snapshot.

### 2.2 `competition_snapshots` (meta + histórico)

| Coluna DB | Origem API | Uso no card |
|-----------|------------|-------------|
| Mesmas colunas de título/preço/thumb/loja/permalink | Snapshot da coleta | Fallback no GET quando row vazia |
| `shipping` (JSONB) | `shipping` do item/catálogo | Frete grátis, mode, logistic_type |
| `listing_type` | `listing_type_id` | Clássico / premium / gold_* |
| `reputation` (JSONB) | `seller.seller_reputation` / `/users` | MercadoLíder |
| `sales_hint` | `sold_quantity` | “N vendas” |
| `raw_snapshot` (JSONB) | Suse7 | `enrich_status`, `context`, debug |
| `captured_at` | Suse7 | Histórico |

**GET lista:** `mapCompetitorsForResponse` mescla **row + último snapshot** (`findLatestSnapshotMetaForCompetitors`).

---

## 3. Endpoints ML utilizados hoje

| Endpoint | Usado em | Token ML |
|----------|----------|----------|
| `GET /products/search?q=` | Busca por nome (broad + legacy) | Sim |
| `GET /products/{id}/items` | Discovery catálogo | Sim |
| `GET /products/{id}` | buy_box_winner, pictures | Sim |
| `GET /items/{id}` | Link resolve, enrich, legacy discover | Sim (403 comum em item de terceiro) |
| `GET /items?ids=` | Fallback multiget enrich | Sim |
| `GET /users/{seller_id}` | Nickname + reputação quando item não traz | Sim |
| ~~`GET /sites/MLB/search`~~ | **Descontinuado (403)** — não usar | — |

Mapeamento central: `mlCompetitorMapping.js` → `mlItemBodyToCandidateRaw`, `mlCatalogItemRowToCandidateRaw`, `mlBuyBoxWinnerToCandidateRaw`.

---

## 4. Tabela de auditoria por campo

Legenda **Confiabilidade:** Alta = estável quando token OK; Média = depende de catálogo/403; Baixa = frequentemente ausente ou só em fluxo específico.

| Campo visual desejado | Campo técnico API | Endpoint / fonte Suse7 | Busca por nome? | Por link? | Confiabilidade | Observações |
|----------------------|-------------------|------------------------|-----------------|-----------|----------------|-------------|
| **ID do anúncio** | `id` / `item_id` | Parser URL; `/items`; `/products/.../items` | Sim | Sim | **Alta** | `competitor_listing_id`; canonical `MLB123…` |
| **Título** | `title` | `/items`; row catálogo; slug URL (fallback) | Sim | Sim / parcial | **Alta** | Fallback slug só visual; preferir API |
| **Permalink** | `permalink` | `/items`; row catálogo; `buildMercadoLivreItemPermalink` | Sim | Sim | **Alta** | Sempre tentar persistir |
| **Thumbnail** | `thumbnail`, `secure_thumbnail`, `pictures[]` | `/items`; pictures do produto catálogo | Sim | Sim / parcial | **Média** | 403 em `/items` → catálogo ou discovery |
| **Preço** | `price` | `/items`; row catálogo; buy_box | Sim | Sim / parcial | **Alta** | Card: `last_seen_price` string decimal |
| **Moeda** | `currency_id` | `/items`; row catálogo | Sim | Sim | **Alta** | Default `BRL` |
| **Loja / nickname** | `seller.nickname` | `/items`; buy_box `seller_nickname`; `/users` | Sim / parcial* | Sim / parcial | **Média** | *Broad: só top 30 com `/items` no preview |
| **Seller ID** | `seller_id`, `seller.id` | `/items`; row catálogo | Sim | Sim | **Média** | Persistir; não exibir no card hoje |
| **Reputação (level)** | `seller.seller_reputation.level_id` | `/items`; `/users` | Parcial | Parcial | **Média** | Preview broad raramente traz; enrich/snapshot melhor |
| **MercadoLíder** | `seller.seller_reputation.power_seller_status` | `/items`; `/users` | Parcial | Parcial | **Média** | Valores: silver, gold, platinum |
| **Tipo anúncio** | `listing_type_id` | `/items`; row catálogo; buy_box | Sim | Parcial | **Média** | gold_special, gold_pro, gold_premium, free, etc. |
| **Frete grátis** | `shipping.free_shipping` | `/items`; row catálogo | Sim | Parcial | **Média** | Não bloquear card se ausente |
| **Modalidade envio** | `shipping.mode`, `shipping.logistic_type` | `/items`; row catálogo | Sim | Parcial | **Média** | Normalizado em `normalizeShipping`; não exibido no card hoje |
| **Condição novo/usado** | `condition` | `/items` | **Não mapeado** | **Não mapeado** | Baixa | Disponível na API; **não entra no contrato atual** |
| **Qtd. vendida** | `sold_quantity` | `/items` (token proprietário) | Sim (`own_listing.sales`) | **Indisponível** p/ concorrente ML | **Média** | `sales_hint`; ver **§13** — limitação API, não bug Suse7 |
| **Estoque** | `available_quantity` | `/items` | **Não mapeado** | **Não mapeado** | Baixa | Não usado em concorrência hoje |
| **Status anúncio** | `status` | `/items` | **Não mapeado** | **Não mapeado** | Média | Útil para filtrar inativos; não no card |
| **Catálogo product_id** | `catalog_product_id` | URL `/p/MLBU…`; `/products/{id}` | Parcial | Parcial | Média | Usado no resolve link; não no card |
| **Marca** | `attributes[BRAND]` | `raw_json` do **anúncio do seller** (query) | Indireto | Indireto | — | Só para montar busca; **não do concorrente** |
| **GTIN/EAN** | `attributes[GTIN/EAN]` | `raw_json` do seller (query) | Indireto | Indireto | — | Idem marca |
| **Atributos principais** | `attributes[]` | `/items` | **Não mapeado** | **Não mapeado** | Baixa | Possível expansão futura |
| **Última coleta** | — | Suse7 `last_captured_at` / `captured_at` | Após save | Após save | **Alta** | Snapshot + touch no update |
| **Status enrich** | — | Suse7 `computeEnrichStatus` | Após save | Sim | **Alta** | `partial` → hint “Dados em atualização” |
| **Origem do dado** | — | `source_strategy` + `raw_snapshot.context` | Sim | Sim | **Alta** | search, link, item, seller, catalog, snapshot |

---

## 5. Comparativo por fluxo

### 5.1 Busca por nome (modal — modo broad)

```
GET /products/search → para cada produto:
  GET /products/{id}/items  → candidato base (preço, frete, tipo, seller_id)
  [opcional] GET /products/{id} → buy_box_winner (loja, preço)
  [top 30] GET /items/{id} → reforço título, loja, thumb, vendas (NÃO reputação no merge atual)
```

**Arquivo:** `MercadoLivreSearchCompetitionStrategy.js` → `discoverBroad`  
**Estratégia:** `ml_broad_search`

### 5.2 Cadastro por link

```
parse URL → GET /items/{id} → enrichCompetitorListing (item → catálogo → /users)
  → se incompleto: discovery fallback (mesmo engine da busca)
  → se parcial: completePartialCompetitorViaDiscovery (cópia campos do candidato discover)
```

**Arquivos:** `competitionLinkCandidateResolver.js`, `competitionLinkDiscoveryCompletion.js`, `competitionListingEnricher.js`  
**Estratégia:** `ml_link` / `ml_link_via_discovery_fallback`

### 5.3 Save (ambos os caminhos)

```
enrichCompetitorForPersist → completePartialCompetitorViaDiscovery (se parcial)
  → competition_competitors
  → insertEnrichSnapshotOnSave → competition_snapshots
```

**Arquivo:** `handlers/competition/index.js` → `postProductCompetitor`

### 5.4 Atualizar concorrentes (snapshot)

```
por concorrente ativo:
  enrichCompetitorForPersist (forceFullEnrich)
  → completePartialCompetitorViaDiscovery (se ainda parcial)
  → append competition_snapshots + update competition_competitors
```

**Arquivo:** `competitionSnapshotService.js` → `captureCompetitorsSnapshot`

---

## 6. Classificação para decisão de layout

### 6.1 Obrigatórios (identidade do card — nunca bloquear cadastro)

| Campo | Motivo |
|-------|--------|
| `competitor_listing_id` | Chave do anúncio |
| `competitor_title` **ou** `competitor_permalink` | Identificação humana |
| `enrich_status` (API) | UX de parcial vs completo |

### 6.2 Recomendados (card “saudável” — desejável, não bloqueante)

| Campo | Motivo |
|-------|--------|
| `competitor_thumbnail` | Reconhecimento visual |
| `last_seen_price` | Comparativo comercial |
| `competitor_store_name` | Contexto do vendedor |
| `shipping.free_shipping` | Diferencial comercial frequente |
| `listing_type` | Clássico vs premium |
| `reputation.power_seller_status` | Confiança do vendedor |
| `sales_hint` | Prova social leve |

### 6.3 Opcionais (nice-to-have / fase futura)

| Campo | Motivo |
|-------|--------|
| `shipping.mode` / `logistic_type` | Fulfillment (Full, flex) — não exibido hoje |
| `reputation.level_id` | Menos legível que power_seller_status |
| `condition` | Novo/usado — não mapeado |
| `available_quantity` | Estoque concorrente |
| `status` | Pausado/encerrado |
| Marca/GTIN/atributos do **concorrente** | Relevância material; exige expandir mapper |

---

## 7. Campos seguros para exibir sempre

Podem renderizar sem risco de “erro fatal” (usar fallback visual se null):

| Campo UI | Fallback seguro |
|----------|-----------------|
| Título | “Anúncio sem título disponível” |
| Preço | “—” |
| Thumbnail | Placeholder ícone |
| Loja | Omitir linha |
| Frete grátis | Omitir badge |
| Tipo anúncio | Omitir |
| MercadoLíder | Omitir badge |
| Vendas | Omitir |
| Link título | Permalink ou URL montada por `listing_id` |
| Status parcial | “Dados em atualização” |

---

## 8. Campos que podem falhar (permissão / endpoint)

| Campo | Causa típica | Mitigação atual |
|-------|--------------|-----------------|
| Thumbnail / preço (link) | `GET /items` 403 em anúncio de terceiro | Catálogo scan + discovery completion |
| Loja | Sem `seller_id` ou `/users` vazio | Discovery copia candidato com loja |
| Reputação | Não vem em row catálogo; item 403 | `/users` após seller_id; snapshot |
| Frete / tipo | Item 403; row catálogo sem match | Discovery + snapshot |
| Vendas | `sold_quantity` só em `/items` | Enrich no save/update |

Logs DEV: `[S7_COMPETITION_ENRICH_RESULT]`, `[S7_COMPETITION_LINK_DISCOVERY_COMPLETION_*]`, `buildEnrichAbsenceReasons`.

---

## 9. Recomendações técnicas (próxima fase — sem implementar agora)

1. **Card mínimo v1 (seguro):** título link + preço + thumb + loja + badge frete + tipo + MercadoLíder + vendas + timestamp/status parcial.
2. **Persistência:** manter split atual — **vivos** em `competition_competitors`; **meta + histórico** em `competition_snapshots`.
3. **Busca broad:** considerar incluir `reputation` e `shipping` no merge dos top 30 em `discoverBroad` (hoje só parte dos campos de `/items` é mesclada) — alinharia preview com card pós-save.
4. **Não persistir** (até decisão de produto): `condition`, `available_quantity`, `status`, atributos completos — mapear primeiro se forem requisito de layout.
5. **Exibição:** `shipping.mode` / `logistic_type` só após copy/label PT-BR (Full, Coleta, etc.).
6. **Financeiro:** preço do card é **informativo** (`last_seen_price`); nunca usar float no front; cálculos de margem ficam fora deste módulo.

---

## 10. Mapeamento card UI ↔ API (estado atual)

| Elemento no `ConcorrenciaProdutoModal` | Campo resposta |
|----------------------------------------|----------------|
| Imagem | `competitor_thumbnail` |
| Título (link) | `competitor_title` + `competitor_permalink` |
| Preço | `last_seen_price` + `last_seen_currency` |
| Loja | `competitor_store_name` |
| “N vendas” | `sales_hint` (snapshot) |
| “Frete grátis” | `shipping.free_shipping` |
| Tipo (texto) | `listing_type` |
| Badge MercadoLíder | `reputation.power_seller_status` |
| “Atualizado em …” | `last_captured_at` |
| “Dados em atualização” | `enrich_status === 'partial' \| 'failed'` |

**Preview busca por nome (candidatos):** exibe preço, loja, frete, tipo; **não** exibe reputação no código atual (só nos cards cadastrados).

---

## 11. Referências de código

| Tópico | Arquivo |
|--------|---------|
| Mapeamento ML → candidato | `strategies/mlCompetitorMapping.js` |
| Busca por nome | `strategies/MercadoLivreSearchCompetitionStrategy.js` |
| Enrich item/seller/catálogo | `competitionListingEnricher.js` |
| Resolve link | `competitionLinkCandidateResolver.js` |
| Completion via discovery | `competitionLinkDiscoveryCompletion.js` |
| Contrato API / persist | `competitionNormalizer.js` |
| Snapshot | `competitionSnapshotService.js` |
| Card UI | `suse7-frontend/.../ConcorrenciaProdutoModal.jsx` |

---

## 12. Auditoria — comissão/taxa do anúncio concorrente (futuro)

**Objetivo:** saber se dá para exibir “Comissão estimada: 13,5%” no card do concorrente. **Não exibir na UI nesta fase.**

### Existe no ecossistema S7?

| Pergunta | Resposta |
|----------|----------|
| **Existe endpoint ML?** | Sim — `GET /sites/{site_id}/listing_prices` com `price`, `listing_type_id`, `category_id`, `currency_id` e opcionalmente `logistic_type` / `shipping_mode`. |
| **Já usado no S7?** | Sim — `fetchListingPricesForItemDetailed` em `mercadoLibreItemsApi.js`; motor de **Precificação Inteligente** (`mercadoLivreListingPricingScenarios.js`, `mercadoLivreOfficialScenarioResolvers.js`). |
| **Dados retornados** | `sale_fee_amount`, `sale_fee_details.percentage_fee`, `listing_type_id`, breakdown de subsídios em alguns cenários. |
| **Confiabilidade** | **Média-alta** para o **próprio** anúncio do seller (token + item completo). Para **concorrente**: depende de `category_id`, `listing_type_id`, preço e frete corretos no item enriquecido; sem `category_id` a API pode falhar ou retornar linha genérica. |
| **Limitações** | (1) Concorrente de terceiros: `/items/{id}` pode ser 403 — enrich cai para catálogo/rows parciais sem `category_id`. (2) Taxa varia por categoria, tipo (Clássico/Premium), frete, campanhas ML — estimativa, não extrato financeiro. (3) Rate limit / latência extra por concorrente no snapshot. (4) Multi-conta: token do seller pode não refletir condição comercial do concorrente. |
| **Recomendação** | Viável como **“Comissão estimada”** no modal/detalhe após enrich completo (`listing_type` + preço + `category_id` do item). Implementar no backend (campo derivado no snapshot), nunca no frontend. Homologar com 3–5 anúncios reais antes de mostrar na lista principal. |

### Próximo passo técnico (quando priorizado)

1. Após `enrichCompetitorListing`, se item tiver `site_id`, `price`, `listing_type_id`, `category_id` → chamar `fetchListingPricesForItemDetailed`.
2. Persistir `sale_fee_percent` / `sale_fee_amount` em `competition_snapshots.raw_snapshot` (somente leitura analítica).
3. Expor no `toCompetitorResponse` como `estimated_commission_percent` (opcional, null-safe).

---

## 13. Quantidade de vendas — resolver dedicado + limitação ML

**Camada:** `competitionSalesHintResolver.js` (separada do enrich principal).

Responsabilidade: receber `item_id`, `permalink`, `catalog_product_id`, token ML e tentar fontes em ordem segura, com **cache em memória** (TTL 6h, configurável via `S7_COMPETITION_SALES_CACHE_TTL_MS`).

### Auditoria direta (cadastro/enrich) — prova definitiva

Sequência obrigatória por cadastro (DEV ou `S7_COMPETITION_SALES_AUDIT=1`):

1. `[S7_COMPETITION_DIRECT_ITEM_AUDIT_START]` — confirma execução + `trigger: save_enrich`
2. `[S7_COMPETITION_DIRECT_ITEM_AUDIT]` — `phase: full_item` e `phase: attributes_item`
3. `[S7_COMPETITION_DIRECT_ITEM_AUDIT_END]` — `resolved`, `scenario`, `sold_quantity_evidence`
4. `[S7_COMPETITION_SALES_PIPELINE_SUMMARY]` — `bottleneck`, `resolved`, `scenario`

Campo `sold_quantity_evidence` (objetivo, sem inferência):

| Valor | Significado |
|-------|-------------|
| `http_200_sold_quantity_present_positive` | **Cenário A** — ML retornou vendas |
| `http_200_sold_quantity_field_absent` | **Cenário B** — 200 sem campo |
| `http_200_sold_quantity_null` | **Cenário B** — campo null |
| `http_200_sold_quantity_zero` | **Cenário B** — zero (não exibimos) |
| `http_403_blocked` | **Cenário B** — bloqueio/permissão |

Log DEV: `[S7_COMPETITION_DIRECT_ITEM_AUDIT]` — consulta real com token conectado:

1. `GET /items/{ITEM_ID}` (corpo completo sanitizado)
2. `GET /items/{ITEM_ID}?attributes=id,title,seller_id,sold_quantity,price,permalink,...`
3. Opcional: `GET /items/{own_listing_id}` para comparar próprio vs terceiro

Se `sold_quantity > 0` → `sales_hint_source = "ml_items_sold_quantity"`, confiança **alta**.

### Fontes investigadas (ordem no resolver)

| Ordem | Fonte | `sales_hint_source` | Confiança |
|-------|-------|---------------------|-----------|
| 1 | Auditoria direta `GET /items/{id}` | `ml_items_sold_quantity` | alta |
| 2 | `GET /items?ids={id}` | `ml_items_multiget` | alta |
| 3 | `GET /items?ids={id}` | `ml_items_multiget` | alta |
| 4 | `GET /products/{catalog_product_id}/items` | `ml_catalog_product_items` | média |
| 5 | `GET /items/{id}/description` (texto) | `ml_item_description_text` | baixa |
| 6 | `GET /items/{id}/visits` | — | **não é venda** (só auditoria) |
| 7 | `GET /items/{id}?attributes=sold_quantity` **sem token** | `ml_items_public` | média |
| 8 | Página pública do permalink (HTML leve) | `ml_public_page_*` | baixa |

**Nota:** visitas ≠ vendas — endpoint de visits é auditado mas **nunca** preenche `sales_hint`.

### Limitação confirmada (baseline)

A ausência de vendas nos cards de **concorrentes** com token do seller logado costuma ser **limitação da API Mercado Livre** (`sold_quantity` exige token proprietário). O resolver **não assume impossibilidade** e tenta todas as fontes acima antes de desistir.

### Anúncio próprio vs concorrente

| Contexto | Campo na API Suse7 | Fonte ML | Disponibilidade |
|----------|-------------------|----------|-----------------|
| **Anúncio próprio** (coluna “Seu anúncio” na lista) | `own_listing.sales` | `sold_quantity` do `raw_json` do listing vinculado (token proprietário) | **Disponível** quando o sync ML trouxe `sold_quantity` |
| **Concorrente** (cards Conc.1–6, modal, discover) | `competitors[].sales_hint` | `sold_quantity` via `GET /items/{ITEM_ID}` | **Indisponível** na prática para terceiros com token do seller logado |

### Regra Mercado Livre (oficial)

Segundo a documentação do Mercado Livre, o campo **`sold_quantity`** em `GET /items/{ITEM_ID}` só é retornado de forma confiável quando o **token OAuth pertence ao vendedor proprietário** daquele anúncio.

Implicações para o Suse7:

- Com o token da conta conectada do seller, lemos vendas do **próprio** anúncio (`own_listing.sales`).
- Para **concorrentes**, o mesmo token **não** é proprietário → `sold_quantity` tende a vir omitido ou a requisição retorna **403**.
- O Suse7 **não inventa** vendas, **não exibe zero** e **não exibe “0 vendas”** quando `sales_hint` é `null`.

### Contrato UI (concorrente)

| `sales_hint` | Renderização |
|--------------|--------------|
| `null` / ausente / `≤ 0` | Somente preço — ex.: `R$ 147,88` |
| número `> 0` | Preço + vendas — ex.: `R$ 147,88 · 324 vendas` |

Implementação: `pickSalesHint` + `formatCompactPriceSales` (lista, modal busca, modal detalhe).

### Pipeline (persistência + response)

1. Enrich principal → se sem vendas → **`resolveCompetitionSalesHint`**
2. Discover → `resolveSalesHintsForDiscoverCandidates` (preview na busca)
3. Save → snapshot `sales_hint` + `raw_snapshot.sales_hint_meta` (`source`, `confidence`, `checked_at`)
4. Response API → `sales_hint`, `sales_hint_source`, `sales_hint_confidence` (opcionais)
5. Frontend → `pickSalesHint` + `formatCompactPriceSales` (só preço se null; nunca zero)

### Logs de auditoria (somente DEV)

Tags `[S7_COMPETITION_SALES_*]` ativas apenas com `NODE_ENV !== production` ou `S7_COMPETITION_SALES_AUDIT=1`. Em produção, sem flag, **sem log verboso** de vendas.

| Log | Uso |
|-----|-----|
| `[S7_COMPETITION_DIRECT_ITEM_AUDIT]` | Prova real `GET /items/{id}` + attributes + own vs competitor |
| `[S7_COMPETITION_SALES_PIPELINE_TRACE]` | Rastreio por `stage` (enrich → snapshot → GET → response) |
| `[S7_COMPETITION_SALES_PIPELINE_SUMMARY]` | Veredito `bottleneck` após cada cadastro |
| `[S7_COMPETITION_SALES_FRONT_TRACE]` | Frontend: `sales_hint`, `pickSalesHint`, `will_show_sales` |
| `[S7_COMPETITION_SALES_RAW_ML]` | Payload ML auditado (sem token) |
| `[S7_COMPETITION_SALES_UNAVAILABLE]` | Concorrente sem `sales_hint` após enrich |
| `[S7_COMPETITION_SALES_AUDIT]` | Rastreio por camada + comparação own vs competitor |

**Stages do pipeline trace (backend):** `after_direct_item_audit` → `after_resolver` → `before_db_save` → `after_snapshot_insert` → `after_db_read_snapshot` → `toCompetitorResponse` → `get_competitors_merge`

**Caminho completo:** ML API → resolver → `competition_snapshots.sales_hint` → GET merge → API `sales_hint` → frontend `pickSalesHint` → card/modal/lista.

---

## 14. Checklist anti-regressão — vendas

- [ ] Busca por nome — OK (sem alteração de UX)
- [ ] Busca por link — OK
- [ ] Cadastro individual / em lote — OK
- [ ] Fila, dedupe, toasts, modal — OK
- [ ] Lista principal — concorrente com `sales_hint: null` → **só preço**
- [ ] Modal detalhe — idem
- [ ] Coluna anúncio próprio — `own_listing.sales` quando existir no `raw_json`
- [ ] Produção — sem logs `[S7_COMPETITION_SALES_*]` sem flag

---

*Documento gerado para homologação e decisão de layout final. Não altera comportamento de produção.*
