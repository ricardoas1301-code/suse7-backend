# ADR-0001 — Suse7 Pricing Contract v1

## Status

**Accepted** (decisão arquitetural vigente)

## Contexto

Antes do protocolo v1, o sistema sofreu com:

- **Mistura de fontes de preço** — `price`, `original_price`, health, `raw_json` e calculadoras competindo sem contrato único.
- **Fallback legado** — `net_receivable`, `net_proceeds` e campos espelhados usados de forma intercambiável.
- **Inconsistência UI × backend** — promoção e “Você recebe” calculados ou inferidos no front em alguns fluxos.
- **Payout duplicado** — repasse recalculado ou misturado com valor oficial do marketplace.
- **Regressões frequentes** — correções em promoção ou payout quebravam outra parte do motor.

Foi necessário formalizar **uma única fonte de verdade** por domínio (preço, promoção, payout) e **um payload explícito** consumido pelo frontend sem inferência.

## Decisão

Adotamos oficialmente o **Suse7 Pricing Contract v1**, materializado no payload de listagens e na documentação de protocolo. Qualquer mudança que altere regras de preço, promoção ou payout **deve** passar por revisão explícita deste ADR (novo ADR ou revisão de status).

### 1. Campos oficiais de pricing (por item na grid)

| Campo | Papel |
|-------|--------|
| `listing_price_brl` | Preço de catálogo / original do anúncio |
| `promotion_active` | `true` somente quando há promoção válida (backend) |
| `promotional_price_brl` | Preço promocional; preenchido **apenas** se `promotion_active === true` |
| `effective_sale_price_brl` | Base **obrigatória** para todos os cálculos de receita/lucro no fluxo da grid |
| `marketplace_payout_amount` | “Você recebe” persistido a partir do marketplace (sync) |
| `marketplace_payout_source` | `ml_official` \| `estimated` \| `unresolved` |

### 2. Fonte de verdade

- **Preço e promoção:** responsabilidade **exclusiva do backend** (`resolveMercadoLivreListingPricingForGrid` + health / item / resolution).
- **Payout:** responsabilidade do **marketplace**, persistida em `marketplace_listing_health`; o backend apenas expõe `marketplace_payout_amount` / `marketplace_payout_source`.
- **Frontend:** **somente consome** os campos do contrato; não redefine regras de negócio de pricing.

### 3. Regras obrigatórias

#### Promoção

- `promotion_active` define se existe promoção no sentido do produto.
- `promotional_price_brl` existe **somente** quando a promoção está ativa e o valor é válido.
- `effective_sale_price_brl` é a base de cálculo: com promo ativa, usa o preço promocional; sem promo, alinha-se ao preço de lista conforme o protocolo.

#### Cálculo

- Sempre usar `effective_sale_price_brl` como base monetária do fluxo oficial (Raio-x, margem, etc., conforme implementação).
- **Proibido** inferir promoção no frontend a partir de diferença de números ou heurísticas locais.

#### Payout

- Sempre usar `marketplace_payout_amount` como “Você recebe” na UI nova.
- **Proibido** recalcular payout no frontend a partir de preço, taxa ou frete.

### 4. Proibições

- Usar `price_brl` como **fonte principal** em novos desenvolvimentos (espelho legado apenas).
- Usar `net_receivable` na UI nova.
- Recalcular payout no frontend.
- Inferir promoção no frontend.
- Misturar campos legados com os campos v1 sem documentação e revisão.

### 5. Campos legados (compatibilidade)

| Campo | Função |
|-------|--------|
| `price_brl` | Espelho do preço **efetivo** para clientes antigos |
| `net_receive_brl` | Espelho do payout (`marketplace_payout_amount`) |
| `net_proceeds` | Objeto legado / breakdown auxiliar; **não** é fonte do payout oficial |

**Regra:** não usar estes campos em **novas** features; manter apenas para compatibilidade até remoção planejada.

### 6. Contrato da API

- **`pricing_protocol`:** `"suse7-pricing-v1"` na resposta de `GET /api/ml/listings`.
- **`listing_grid_contract_version`:** número incrementado quando o shape monetário quebrar consumidores; evoluções devem documentar bump neste ADR ou em ADR filho.

### 7. Checklist obrigatório de validação (antes de merge em área de pricing)

- [ ] Cenário **sem** promoção: UI e cálculos coerentes com `listing_price_brl` / `effective_sale_price_brl`.
- [ ] Cenário **com** promoção: `promotion_active`, `promotional_price_brl` e `effective_sale_price_brl` alinhados.
- [ ] Cenário **saindo** de promoção: flags e valores limpos após sync.
- [ ] Payout **idêntico** entre coluna da grid, Raio-x e payload (`marketplace_payout_amount`).
- [ ] Payload com chaves v1 garantidas (`ensureListingGridMoneyContract`).

## Consequências

### Positivas

- Previsibilidade e contrato testável.
- Menos bugs por ambiguidade de fonte.
- Manutenção e onboarding mais simples.
- Base clara para **multi-marketplace** (mesmo padrão de campos por canal).

### Negativas / trade-offs

- Manutenção de **compatibilidade** com campos legados por um tempo.
- **Disciplina obrigatória** do time: mudanças em pricing exigem alinhamento com este ADR e com o protocolo.

## Referências

| Recurso | Caminho |
|---------|---------|
| Protocolo detalhado (campos, checklist) | [SUSE7_PRICING_PROTOCOL_V1.md](../SUSE7_PRICING_PROTOCOL_V1.md) |
| Garantia de chaves no JSON da grid | `src/handlers/ml/_helpers/listingGridAssembler.js` |
| Resolver ML + shape da linha | `src/handlers/ml/_helpers/marketplaces/mercadoLivreListingGrid.js` |
| Orquestração da rota | `src/handlers/ml/listingsList.js` |
| UI catálogo (consumo do contrato) | `suse7-frontend/src/components/Anuncios.jsx` |

## Histórico

| Data | Alteração |
|------|-----------|
| 2026-04-09 | ADR criado — consolidação do Pricing Contract v1 como decisão arquitetural oficial |
