# MISSÃO — Fase 3: Desbloqueio P0 e Homologação Final (Notificações & Exportações)

Data: 2026-06-23

## Arquivos auditados

### Frontend — relatório distribuído e canais
- `suse7-frontend/src/features/vendas/reports/buildVendasAggregatedReport.js`
- `suse7-frontend/src/features/vendas/reports/share/buildVendasSharePayload.js`
- `suse7-frontend/src/features/vendas/reports/share/buildVendasReportXlsx.js`
- `suse7-frontend/src/features/vendas/reports/share/buildVendasReportPrintContent.js`
- `suse7-frontend/src/features/vendas/reports/share/buildVendasReportShareAssets.js`
- `suse7-frontend/src/features/vendas/reports/share/shareVendasReportWhatsApp.js`
- `suse7-frontend/src/features/vendas/reports/share/shareVendasReportEmail.js`
- `suse7-frontend/src/features/vendas/reports/share/fetchVendasReportDetailRows.js`
- `suse7-frontend/src/features/vendas/reports/VendasRelatorioCanais.jsx`
- `suse7-frontend/src/features/vendas/reports/buildDailySalesSummaryNotificationModalData.js`
- `suse7-frontend/src/features/vendas/selection/aggregateVendasSelectedSalesMetrics.js`
- `suse7-frontend/src/pages/NotificacoesInboxPage.jsx`
- `suse7-frontend/src/components/notifications/central/DailySalesSummaryNotificationModalHost.jsx`

### Backend — notificações e motor central
- `suse7-backend/src/handlers/notifications/saleRayxManualNotificationApi.js`
- `suse7-backend/src/handlers/notifications/salesReportManualNotificationApi.js`
- `suse7-backend/src/domain/notifications/central/sales/triggerManualSaleRayxNotification.js`
- `suse7-backend/src/domain/notifications/central/sales/triggerManualSalesReportNotification.js`
- `suse7-backend/src/domain/notifications/central/sales/processDailySalesSummaryAutomationMotor.js`
- `suse7-backend/src/domain/notifications/central/sales/triggerDailySalesSummaryNotification.js`
- `suse7-backend/src/domain/notifications/central/sales/buildDailySalesSummaryTemplatePayload.js`
- `suse7-backend/src/domain/sales/loadSaleOrderItemForSeller.js`
- `suse7-backend/src/handlers/notifications/notificationEventDetail.js`

## Fluxos mapeados (Origem -> Transformação -> Payload -> Canal)

### 1) Notificações — Raio-X manual (WhatsApp/E-mail)
- Origem: `sales_order_items.raw_json._s7_financial` via `loadSaleOrderItemForSeller`.
- Transformação: `buildSaleDetailFinancialBreakdown` com snapshot-first e `snapshot_missing` explícito.
- Payload: `sale.notificationPayload`.
- Canal final: `triggerManualSaleRayxNotification` -> outbox WhatsApp/E-mail.

### 2) Notificações — Relatório de vendas manual (WhatsApp/E-mail)
- Origem: `executive-summary` + seleção da página Vendas (contrato agregado).
- Transformação: `buildVendasAggregatedReport` -> `buildVendasSharePayload`.
- Payload: `template_payload` + anexos (PNG/XLSX) via `buildVendasReportShareAssets`.
- Canal final: `triggerManualSalesReportNotification` -> outbox WhatsApp/E-mail.

### 3) Notificações — Resumo Diário (Popup/Sininho/WhatsApp/E-mail)
- Origem: `buildSaleExecutiveSummary` (backend).
- Transformação: `buildDailySalesSummaryTemplatePayload`.
- Payload: evento `SALES:DAILY_SALES_SUMMARY` com `channels`.
- Canal final: in-app/sininho + popup + e-mail + WhatsApp pelo motor central.

### 4) Exportações e compartilhamento (Excel/Copy/Print/WhatsApp/E-mail)
- Origem: mesmo contrato único `buildVendasAggregatedReport`.
- Transformação: `buildVendasSharePayload` (sem recálculo paralelo).
- Payload: imagem executiva, HTML copy/print e XLSX.
- Canal final: download/local print/copiar + envio manual WhatsApp/E-mail.

## Evidências e correções realizadas

## Correção P0-1 — remoção de recálculo paralelo no payload distribuído
- Arquivo: `suse7-frontend/src/features/vendas/reports/share/buildVendasSharePayload.js`
- Antes: agregava custos/ticket a partir de `vendasDetalhe` (`aggregateFromReportRows`) com parse/soma local.
- Depois: consome somente `resumoExecutivo` do contrato agregado (fonte única), sem recomputar custos/lucro/margem.
- Efeito: canais (Excel/Copy/Print/WhatsApp/E-mail) passam a reproduzir o mesmo núcleo SSOT sem motor paralelo no payload.

## Correção P0-2 — agregação monetária em seleção migrada para Decimal
- Arquivo: `suse7-frontend/src/features/vendas/selection/aggregateVendasSelectedSalesMetrics.js`
- Antes: somas monetárias e margem em `number`.
- Depois: totais/média/margem com `Decimal`.
- Efeito: elimina risco de drift por float no escopo de seleção manual, mantendo aderência S7-HIST-002.

## Validação executada
- `node --check suse7-frontend/src/features/vendas/reports/share/buildVendasSharePayload.js` -> PASS
- `node --check suse7-frontend/src/features/vendas/selection/aggregateVendasSelectedSalesMetrics.js` -> PASS
- `npm run ssot:guard` (backend) -> `ERROR=0`, `WARNING=22`, `INFO=0`

## Tabela final

| Área | Status | Observação |
|---|---|---|
| Notificações — Resumo Diário | PASS | Fonte em `buildSaleExecutiveSummary`; distribuição por evento único para in-app/popup/WhatsApp/e-mail |
| Notificações — Popup | PASS | Consome mesmo `event_payload` do Resumo Diário |
| Notificações — Sininho | PASS | Consome mesmo `event_payload` do Resumo Diário |
| Notificações — WhatsApp (Raio-X/Relatório) | PASS | Payload manual consolidado; sem fallback vivo financeiro |
| Notificações — E-mail (Raio-X/Relatório) | PASS | Mesmo contrato/payload do WhatsApp, com render específico de canal |
| Exportações — Excel | PASS | Deriva do contrato único + linhas da API `/api/sales` |
| Exportações — Copy | PASS | Deriva do payload único (imagem executiva) |
| Exportações — Print | PASS | Deriva do payload único (HTML de impressão) |
| Exportações — WhatsApp | PASS | Usa mesmos assets (PNG/XLSX) do contrato único |
| Exportações — E-mail | PASS | Usa mesmos assets (PNG/XLSX) do contrato único |
| Relatórios distribuídos (anexos/payloads) | PASS | Nenhum recálculo paralelo de lucro/margem/custo/imposto/operação/ML Ads no payload final |

## Fechamento da fase

- `BLOCKED/P0` removido para Notificações e Exportações no checkout atual.
- Nenhum `FAIL` identificado nas áreas auditadas nesta fase.
- Homologação SSOT de Notificações/Exportações concluída para lançamento.
