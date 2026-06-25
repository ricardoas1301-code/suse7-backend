# PI — Engine financeira homologada (congelamento oficial)

**Trilha:** PI.2.10 / PI.2.10A  
**Status:** CONGELADA — homologada contra Simulador de Custos do Mercado Livre  
**Data de referência:** 2026-06-11 (Mission Control S7)

---

## Regra zero

A engine financeira da Precificação Inteligente **não pode ser alterada** sem:

1. Nova trilha explícita (ex.: PI.2.x)
2. Nova homologação contra o simulador oficial ML
3. Atualização dos contratos em `tests/pricing/contratosHomologados.mjs`
4. Regressão verde: `npm run test:pricing-engine-homologada`

**Proibido alterar sem trilha:** tarifa, frete, recebe, lucro, margem, solver preço↔margem, reserva estratégica, afiliados, ML Ads, custos operacionais.

Refinos UX/UI (PI.2.11+) **não tocam** estes módulos.

---

## Arquivos congelados (backend)

| Arquivo | Papel |
|---------|--------|
| `src/domain/pricing/mercadoLivreListingPricingScenarios.js` | **`computeOneScenario`** — engine única de cenário ML |
| `src/domain/pricing/mercadoLivreListingPricingScenarios.js` | **`computeMercadoLivreScenarioComoRayxParaPI`** — orquestração PI / Raio-X |
| `src/domain/pricing/pricingFinancialCalculator.js` | Identidade payout, repasse, anti-stale tarifa |
| `src/domain/pricing/mercadoLivreSimulateListingTypeScenario.js` | Simulação por tipo + **solver margem→preço** (`resolverPrecoParaMargem`) |
| `src/domain/pricing/mercadoLivreOfficialScenarioResolvers.js` | Tarifa oficial `GET listing_prices` por preço/tipo |
| `src/domain/pricing/mercadoLivreScenarioShippingResolve.js` | Frete oficial (listing_prices → shipping_options/free → shipping_options) |
| `src/domain/pricing/aplicarExtrasPrecificacaoInteligente.js` | Reserva estratégica + custos operacionais PI |
| `src/domain/pricing/marketplacePricingSimulator.js` | Contrato `financial` flat para frontend |
| `src/handlers/ml/listingPricingSimulateScenario.js` | `POST /api/ml/listings/pricing-simulate-scenario` |

## Arquivos congelados (frontend — orquestração, sem cálculo financeiro)

| Arquivo | Papel |
|---------|--------|
| `src/components/pricing/PricingPageSalePriceSimulator.jsx` | Comparativo Clássico × Premium, intents por card |
| `src/components/pricing/useSimulacaoOficialListingType.js` | Debounce/cache — chama backend, não calcula |
| `src/utils/simulateListingTypeScenarioOficial.js` | Cliente HTTP do resolver oficial |

---

## Fluxo de cálculo (PI)

```
PricingPageSalePriceSimulator
  → useSimulacaoOficialListingType (intents classic | premium)
  → POST pricing-simulate-scenario { listingType, salePrice | targetMarginPct, financialExtras }
  → MercadoLivrePricingSimulator.simulate()
  → simulateMercadoLivreListingTypeScenario()
       listingType → gold_pro | gold_special
       [margem] → resolverPrecoParaMargem (solver homologado)
  → computeMercadoLivreScenarioComoRayxParaPI()
       → computeOneScenario()  ← engine única
            → resolverTarifaOficialMercadoLivrePorPreco (listing_prices)
            → resolveMercadoLivreScenarioShippingAsync (frete oficial)
            → custos internos + impostos
  → aplicarExtrasPrecificacaoInteligente() (se extras PI ativos)
  → mapMercadoLivreScenarioToFlatFinancialContract
  → card + gráfico
```

**Única diferença Clássico × Premium:** `listing_type_id` (`gold_special` vs `gold_pro`) → tarifa oficial ML distinta. Todo o restante é a mesma engine.

---

## Dependências externas

| Fonte | Uso |
|-------|-----|
| `GET /sites/MLB/listing_prices` | Tarifa oficial por preço e tipo de anúncio |
| `GET /users/{id}/shipping_options/free` | Frete em preços baixos (PI custom price) |
| `GET /items/{id}/shipping_options?price=` | Frete por candidatos / payout match |
| Health / listing persistido | Anti-stale (nunca reutilizar tarifa/frete de catálogo em preço simulado) |
| Decimal.js | Dinheiro — sem float |

---

## Contratos homologados

Listing principal: **MLB6086959274** (Premium vendendo; Clássico alternativo).

### Premium (`gold_pro`)

| Preço | Tarifa | Frete | Recebe | Lucro | Margem |
|-------|--------|-------|--------|-------|--------|
| 299,90 | 40,49 | 68,65 | 190,76 | 42,61 | 14,21% |
| 284,90 | 38,46 | 68,65 | 177,79 | 30,54 | 10,72% |
| 109,00 | 17,98 | 48,05 | 42,97 | — | — |
| 65,00 | 10,72 | 10,95 | 43,33 | — | — |

### Clássico (`gold_special`) — mesmo listing simulado

| Preço | Tarifa (11,50%) | Frete | Recebe |
|-------|-----------------|-------|--------|
| 149,90 | 17,24 | *(live)* | *(live)* |
| 105,00 | 12,08 | *(live)* | *(live)* |
| 58,00 | 6,67 | *(live)* | *(live)* |
| 35,00 | 4,03 | *(live)* | *(live)* |
| 109,00 | 12,54 | 48,05 | 48,41 |
| 65,00 | 7,48 | 10,95 | 46,57 |

Identidade: **Recebe = Preço − Tarifa − Frete** (tolerância ±R$ 0,02).

### Extras PI (65,00 — ambos os cards)

Reserva: Promoção 5% + Afiliados 2,5% | Operacionais: ML Ads 1% + Custos 2%

| Tipo | Lucro | Margem |
|------|-------|--------|
| Clássico | −94,32 | −145,11% |
| Premium | −97,56 | −150,09% |

Extras incidem sobre **preço de venda**; lucro = recebe − custos internos − extras.

---

## Regras congeladas

1. **Anti-stale:** nunca usar tarifa 40,49 ou frete 68,65 do catálogo ao simular 109 / 65 / preços baixos.
2. **Tarifa:** somente `ml_listing_prices`; parser aceita linhas sem `listing_type_id` quando query filtrada.
3. **Frete PI baixo:** `shipping_options/free` + `rayx_custom_price`; homologado separado de faixa alta.
4. **Solver:** busca binária + refinamento; tolerância ±0,01 p.p. margem; mesma engine Premium e Clássico.
5. **Extras:** sincronizam nos dois cards via `configuracaoFinanceira` + cache key.
6. **Frontend:** zero cálculo de tarifa/frete/repasse — só renderiza contrato oficial.

---

## Testes de regressão

```bash
cd suse7-backend

# Offline (obrigatório antes de merge / refino UX)
npm run test:pricing-engine-homologada

# Live (validação API ML — requer token)
ML_ACCESS_TOKEN=... npm run test:pricing-engine-homologada:live
```

Arquivos:

- `tests/pricing/contratosHomologados.mjs` — valores congelados
- `tests/pricing/regressaoEnginePi.mjs` — suíte oficial
- `scripts/validar_precificacao_premium_regressao.mjs` — wrapper legado

---

## Proteção no código

Bloco `ENGINE FINANCEIRA HOMOLOGADA` nos arquivos centrais listados acima. Alteração exige aprovação explícita do time + nova homologação.

---

## Próxima fase

**PI.2.11** — Refinos UX/UI (João). Escopo: visual, layout, microinterações. **Fora de escopo:** qualquer item desta engine.
