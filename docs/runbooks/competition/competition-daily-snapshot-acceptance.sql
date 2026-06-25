with janela as (
  select
    ((date_trunc('day', now() at time zone 'America/Sao_Paulo')
      at time zone 'America/Sao_Paulo')) as inicio_utc,
    (((date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '1 day')
      at time zone 'America/Sao_Paulo')) as fim_utc
),
snap_ult as (
  select distinct on (s.competitor_id)
    s.competitor_id,
    s.captured_at as ultimo_snapshot_captured_at
  from competition_snapshots s
  order by s.competitor_id, s.captured_at desc
),
ativos as (
  select
    c.id,
    greatest(
      coalesce(c.last_captured_at, 'epoch'::timestamptz),
      coalesce(su.ultimo_snapshot_captured_at, 'epoch'::timestamptz)
    ) as ultima_verificacao_efetiva
  from competition_competitors c
  left join snap_ult su on su.competitor_id = c.id
  where c.is_active = true
)
select 'ativos_totais' as metrica, count(*)::bigint as valor from ativos
union all
select 'verificados_hoje_brt', count(*)::bigint
from ativos a, janela j
where a.ultima_verificacao_efetiva >= j.inicio_utc
  and a.ultima_verificacao_efetiva < j.fim_utc
union all
select 'pendentes_hoje_brt', count(*)::bigint
from ativos a, janela j
where a.ultima_verificacao_efetiva < j.inicio_utc
   or a.ultima_verificacao_efetiva is null;
