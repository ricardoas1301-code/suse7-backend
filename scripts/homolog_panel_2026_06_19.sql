-- ======================================================================
-- PAINEL SQL DE HOMOLOGAÇÃO — 19/06/2026
-- Cole no SQL Editor do Supabase. Tudo SELECT (read-only).
-- Fuso de exibição: America/Sao_Paulo (BRT). Timestamps no banco são UTC.
--
-- Seções:
--   A) Últimas runs do DAILY_SALES_SUMMARY de hoje (e 48h)
--   B) Runs de hoje x janelas configuradas (esperado vs realizado) por conta
--   C) Horários cadastrados nas preferências (regras)
--   D) Vendas no período usado pelo último resumo
--   E) RF Móveis — por que o dashboard aparece vazio (vendas existem + sync travado)
-- ======================================================================


-- ----------------------------------------------------------------------
-- A) ÚLTIMAS RUNS DO DAILY_SALES_SUMMARY (hoje + 48h)
-- ----------------------------------------------------------------------
SELECT
  r.id                                                   AS run_id,
  r.seller_id,
  r.status,
  r.event_id,
  (r.scheduled_at AT TIME ZONE 'America/Sao_Paulo')      AS scheduled_brt,
  (r.created_at   AT TIME ZONE 'America/Sao_Paulo')      AS created_brt,
  (r.completed_at AT TIME ZONE 'America/Sao_Paulo')      AS completed_brt,
  EXTRACT(EPOCH FROM (r.created_at - r.scheduled_at))::int AS delay_scheduler_seconds,
  (r.period_start AT TIME ZONE 'America/Sao_Paulo')      AS period_start_brt,
  (r.period_end   AT TIME ZONE 'America/Sao_Paulo')      AS period_end_brt,
  r.error_message
FROM s7_notification_automation_runs r
WHERE r.type_key = 'DAILY_SALES_SUMMARY'
  AND r.created_at >= now() - interval '48 hours'
ORDER BY r.created_at DESC;


-- ----------------------------------------------------------------------
-- A2) Só de HOJE (BRT). Se vier vazio => nenhuma run nasceu hoje.
-- ----------------------------------------------------------------------
SELECT
  r.seller_id,
  count(*) AS runs_hoje,
  min(r.scheduled_at AT TIME ZONE 'America/Sao_Paulo') AS primeira_sched_brt,
  max(r.scheduled_at AT TIME ZONE 'America/Sao_Paulo') AS ultima_sched_brt
FROM s7_notification_automation_runs r
WHERE r.type_key = 'DAILY_SALES_SUMMARY'
  AND (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
GROUP BY r.seller_id;


-- ----------------------------------------------------------------------
-- C) HORÁRIOS CADASTRADOS NAS PREFERÊNCIAS (regras ativas)
--     config->'times' guarda os horários (BRT) escolhidos pelo seller.
-- ----------------------------------------------------------------------
SELECT
  rl.seller_id,
  rl.enabled,
  rl.config ->> 'times'                  AS times_raw,
  rl.config -> 'times'                   AS times_json,
  rl.config -> 'weekdays'                AS weekdays_json,
  rl.config -> 'days'                    AS days_json,
  (rl.last_successful_run_at AT TIME ZONE 'America/Sao_Paulo') AS last_ok_brt,
  (rl.updated_at AT TIME ZONE 'America/Sao_Paulo')            AS updated_brt,
  rl.config                              AS config_full
FROM s7_notification_automation_rules rl
WHERE rl.type_key = 'DAILY_SALES_SUMMARY'
ORDER BY rl.updated_at DESC;


-- ----------------------------------------------------------------------
-- B) ESPERADO x REALIZADO HOJE — para cada horário configurado, houve run?
--     Expande config->'times' (BRT) e procura run de hoje próxima (±15min).
-- ----------------------------------------------------------------------
WITH regras AS (
  SELECT rl.seller_id,
         jsonb_array_elements_text(rl.config -> 'times') AS hora_brt
  FROM s7_notification_automation_rules rl
  WHERE rl.type_key = 'DAILY_SALES_SUMMARY' AND rl.enabled = true
),
slots AS (
  SELECT
    g.seller_id,
    g.hora_brt,
    ((now() AT TIME ZONE 'America/Sao_Paulo')::date + (g.hora_brt || ':00')::time)
      AT TIME ZONE 'America/Sao_Paulo' AS slot_utc
  FROM regras g
)
SELECT
  s.seller_id,
  s.hora_brt                                          AS horario_configurado_brt,
  (s.slot_utc AT TIME ZONE 'America/Sao_Paulo')       AS slot_esperado_brt,
  r.id                                                AS run_id,
  r.status                                            AS run_status,
  (r.scheduled_at AT TIME ZONE 'America/Sao_Paulo')   AS run_scheduled_brt,
  (r.created_at   AT TIME ZONE 'America/Sao_Paulo')   AS run_created_brt,
  CASE WHEN r.id IS NULL THEN 'SEM RUN (trigger nao bateu ou dia/tolerancia)' ELSE 'OK' END AS diagnostico
FROM slots s
LEFT JOIN s7_notification_automation_runs r
  ON r.type_key = 'DAILY_SALES_SUMMARY'
 AND r.seller_id = s.seller_id
 AND r.scheduled_at BETWEEN s.slot_utc - interval '15 min' AND s.slot_utc + interval '15 min'
ORDER BY s.seller_id, s.hora_brt;


-- ----------------------------------------------------------------------
-- D) VENDAS NO PERÍODO DO ÚLTIMO RESUMO (base: date_created_marketplace)
--     Usa o period_start/period_end da última run concluída por seller.
-- ----------------------------------------------------------------------
WITH ultima_run AS (
  SELECT DISTINCT ON (r.seller_id)
    r.seller_id, r.period_start, r.period_end, r.scheduled_at
  FROM s7_notification_automation_runs r
  WHERE r.type_key = 'DAILY_SALES_SUMMARY' AND r.status = 'completed'
  ORDER BY r.seller_id, r.created_at DESC
)
SELECT
  ma.user_id                                              AS seller_id,
  ma.id                                                   AS marketplace_account_id,
  ma.ml_nickname,
  (ur.period_start AT TIME ZONE 'America/Sao_Paulo')      AS period_start_brt,
  (ur.period_end   AT TIME ZONE 'America/Sao_Paulo')      AS period_end_brt,
  count(DISTINCT so.id)                                   AS qtd_vendas,
  coalesce(sum(soi.quantity), 0)                          AS unidades,
  round(coalesce(sum(soi.gross_amount), 0)::numeric, 2)   AS faturamento_bruto,
  round(coalesce(sum(soi.net_amount), 0)::numeric, 2)     AS receita_liquida,
  round(coalesce(sum(soi.fee_amount), 0)::numeric, 2)     AS taxas
FROM ultima_run ur
JOIN marketplace_accounts ma ON ma.user_id = ur.seller_id
LEFT JOIN sales_orders so
       ON so.marketplace_account_id = ma.id
      AND so.date_created_marketplace >= ur.period_start
      AND so.date_created_marketplace <  ur.period_end
LEFT JOIN sales_order_items soi ON soi.sales_order_id = so.id
GROUP BY ma.user_id, ma.id, ma.ml_nickname, ur.period_start, ur.period_end
ORDER BY ma.user_id;


-- ----------------------------------------------------------------------
-- E1) RF MÓVEIS — VENDAS EXISTEM? (mês atual / 60d / total)
-- ----------------------------------------------------------------------
WITH conta AS (
  SELECT id, user_id, ml_nickname, account_alias, external_seller_id,
         status, ml_sales_last_sync_at
  FROM marketplace_accounts
  WHERE lower(coalesce(ml_nickname,'') || ' ' || coalesce(account_alias,'')) LIKE '%rfmoveis%'
     OR lower(coalesce(ml_nickname,'') || ' ' || coalesce(account_alias,'')) LIKE '%rf %'
     OR lower(coalesce(ml_nickname,'') || ' ' || coalesce(account_alias,'')) LIKE '%movei%'
)
SELECT
  c.ml_nickname,
  c.id AS marketplace_account_id,
  c.user_id AS seller_id,
  c.status,
  (c.ml_sales_last_sync_at AT TIME ZONE 'America/Sao_Paulo') AS ultima_sync_vendas_brt,
  count(*) FILTER (
    WHERE so.date_created_marketplace >= date_trunc('month', now())
  ) AS vendas_mes_atual,
  count(*) FILTER (
    WHERE so.date_created_marketplace >= now() - interval '60 days'
  ) AS vendas_60d,
  count(*) AS vendas_total,
  max(so.date_created_marketplace AT TIME ZONE 'America/Sao_Paulo') AS ultima_venda_brt
FROM conta c
LEFT JOIN sales_orders so ON so.marketplace_account_id = c.id
GROUP BY c.ml_nickname, c.id, c.user_id, c.status, c.ml_sales_last_sync_at;


-- ----------------------------------------------------------------------
-- E2) RF MÓVEIS — POR QUE O BANNER "IMPORTAÇÃO EM ANDAMENTO" NÃO SAI
--     Status dos jobs de onboarding (hot pipeline travado).
-- ----------------------------------------------------------------------
WITH conta AS (
  SELECT id FROM marketplace_accounts
  WHERE lower(coalesce(ml_nickname,'') || ' ' || coalesce(account_alias,'')) LIKE '%rfmoveis%'
     OR lower(coalesce(ml_nickname,'') || ' ' || coalesce(account_alias,'')) LIKE '%movei%'
)
SELECT
  j.job_type,
  j.status,
  count(*) AS qtd,
  max(j.updated_at AT TIME ZONE 'America/Sao_Paulo') AS ultimo_update_brt,
  (array_agg(j.error_message) FILTER (WHERE j.error_message IS NOT NULL))[1] AS erro_exemplo
FROM marketplace_account_sync_jobs j
JOIN conta c ON c.id = j.marketplace_account_id
GROUP BY j.job_type, j.status
ORDER BY j.job_type, j.status;


-- ----------------------------------------------------------------------
-- E3) (OPCIONAL / AÇÃO) RECUPERAÇÃO DO PIPELINE HOT TRAVADO
--     Jobs hot que foram para "error" por stale_running_timeout enquanto o
--     worker estava quebrado (HTTP 500 do dia 18/06). Reabilita para o worker
--     — agora 200 — reprocessar. GENÉRICO p/ todas as contas (sem hardcode).
--     DESCOMENTE para executar. Reversível (volta o status).
-- ----------------------------------------------------------------------
-- UPDATE marketplace_account_sync_jobs
--    SET status = 'pending',
--        error_message = NULL,
--        started_at = NULL,
--        finished_at = NULL,
--        updated_at = now()
--  WHERE marketplace = 'mercado_livre'
--    AND status = 'error'
--    AND error_message LIKE 'stale_running_timeout%'
--    AND job_type IN ('ml_initial_sales_recent','ml_initial_sales_history');
--
-- Após reabilitar o sales hot, os passos seguintes (listings/fees/products/
-- customers/monitoring) saem de "pending bloqueado" automaticamente quando o
-- sales hot ficar "done". Acompanhe com a seção E2.
