# MISSAO — Homologacao Global SSOT (Fase 2)

Data: 2026-06-23  
Escopo: Dashboard, Vendas, Produtos, Concorrencia, Precificacao, Notificacoes, Exportacoes, APIs internas.

## Resultado consolidado por area

| Area | Status | Fonte financeira | Risco principal | Correcao necessaria | Prioridade |
|---|---|---|---|---|---|
| Dashboard (Resumo Diario / Top 10 / KPIs) | WARNING | `/api/sales/executive-summary` + motor diario backend | Parte do frontend do dashboard sem cobertura completa no checkout atual | Garantir que todos os cards renderizam payload do executive-summary sem recalc local | P1 |
| Vendas — Lista | PASS | `GET /api/sales` (`_vendasSalesRows` snapshot-first) | Baixo | Nenhuma acao critica | - |
| Vendas — Resumo Executivo | PASS | `GET /api/sales/executive-summary` (`buildSaleExecutiveSummary`) | Baixo | Nenhuma acao critica | - |
| Vendas — Raio-X (tela API detail) | PASS | `GET /api/sales/detail` snapshot-first | Pode acionar enriquecimento vivo em GET quando snapshot incompleto | Mover enriquecimento para job/escrita explicita | P2 |
| Vendas — Resumo simples (`/api/sales/summary`) | WARNING | Agregacao direta em colunas persistidas | Usa Number/float em agregacao monetaria | Migrar para Decimal | P1 |
| Produtos — Vendas & Desempenho | PASS | `useProductFinancialRayX` + executive-summary | Baixo | Nenhuma acao critica | - |
| Produtos — Historico de vendas | PASS | `GET /api/sales?product_id` (`row.financials`) | Baixo | Nenhuma acao critica | - |
| Produtos — Anuncios/Custos | PASS | Contratos canonicos de pricing + snapshots | Baixo | Nenhuma acao critica | - |
| Produtos — Saude no catalogo | WARNING | `productCatalogRow.js` com fallback local (lucro=receita-custo; margem=lucro/receita) | Calculo paralelo legado em fallback | Remover fallback de calculo e exigir banda/margem canonica do backend | P1 |
| Concorrencia (indicadores/relatorios) | PASS | Comparativos de preco + dados backend | Nao usa lucro historico | Nenhuma acao critica | - |
| Precificacao (historico/simulacoes/comparativos) | PASS | Endpoints canonicamente backend (`pricing-scenarios`/`simulate`) | Baixo | Manter sem recalc local | - |
| Notificacoes — Resumo diario / Popups / Sininho / WhatsApp / E-mail | FAIL* | Rotas existem, mas codigo-fonte de handlers de notificacao nao esta no checkout atual para auditoria completa | Nao certificavel por evidencia local completa | Restaurar checkout completo e repetir auditoria dos handlers | P0 |
| Exportacoes — Excel / Copy / Print / WhatsApp / E-mail | FAIL* | Parte dos fluxos front/share sem fontes completas no checkout | Risco de recalc paralelo nao auditado | Restaurar fontes e validar pipeline de exportacao ponta a ponta | P0 |
| APIs internas `/api/sales/*` | WARNING | Majoritariamente snapshot-first | `loadSaleOrderItemForSeller` usa produto/imposto atuais no fallback | Alinhar com `detail.js` (sem product/tax vivos para historico) | P1 |
| APIs internas `/api/products/*` | PASS | `products/performance` usa snapshots/listing snapshots persistidos | Fonte diferente da trilha de vendas historicas | Documentar diferenca de contrato | P2 |
| APIs `/api/reports/*` e agregadores | WARNING | Familia `/api/reports/*` nao encontrada no checkout atual | Nao aplicavel/nao certificavel | Inventariar endpoints reais de relatorio e auditar novamente | P1 |

\* FAIL por bloqueio de auditabilidade local (checkout parcial), nao por reprova tecnica confirmada do fluxo.

## Achado critico confirmado (FAIL funcional)

1. `src/domain/sales/loadSaleOrderItemForSeller.js`  
   - Injeta `products.cost_price/packaging_cost/operational_cost` e imposto atual (`resolveSaleInternalTaxProfile`) ao montar financeiro quando falta snapshot completo.  
   - Isso pode divergir da regra SSOT historica para payload manual de notificacao (`sale rayx`).

## Criterio de aceite para producao

Para atender "nenhuma tela financeira em FAIL":

1. Resolver P0 (restaurar checkout completo de notificacoes/exportacoes e auditar os fluxos ausentes).
2. Corrigir P1 funcional em `loadSaleOrderItemForSeller.js` para impedir fallback vivo em historico.
3. Remover/neutralizar fallback paralelo em `productCatalogRow.js`.
4. Reexecutar auditoria global e obter status final sem FAIL.

