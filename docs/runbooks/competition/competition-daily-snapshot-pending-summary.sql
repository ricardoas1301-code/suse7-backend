with janela as (
  select
    ((date_trunc('day', now() at time zone 'America/Sao_Paulo')
      at time zone 'America/Sao_Paulo')) as inicio_utc
),
snap_ult as (
  select distinct on (s.competitor_id)
    s.competitor_id,
    s.captured_at as ultimo_snapshot_captured_at,
    s.raw_snapshot
  from competition_snapshots s
  order by s.competitor_id, s.captured_at desc
),
base as (
  select
    c.id as competitor_id,
    c.user_id,
    c.product_id,
    c.marketplace,
    c.marketplace_account_id,
    c.competitor_listing_id,
    c.competitor_listing_status,
    c.last_captured_at,
    c.updated_at,
    su.ultimo_snapshot_captured_at,
    su.raw_snapshot,
    greatest(
      coalesce(c.last_captured_at, 'epoch'::timestamptz),
      coalesce(su.ultimo_snapshot_captured_at, 'epoch'::timestamptz)
    ) as ultima_verificacao_efetiva
  from competition_competitors c
  left join snap_ult su on su.competitor_id = c.id
  where c.is_active = true
),
pendentes as (
  select b.*
  from base b
  cross join janela j
  where b.ultima_verificacao_efetiva < j.inicio_utc
),
conta as (
  select
    p.*,
    ma.external_seller_id
  from pendentes p
  left join marketplace_accounts ma
    on ma.id = p.marketplace_account_id
   and ma.user_id = p.user_id
   and ma.marketplace = p.marketplace
),
token_info as (
  select
    c.*,
    coalesce(ts.ml_user_id, tf.ml_user_id) as token_ml_user_id,
    coalesce(ts.expires_at, tf.expires_at) as token_expires_at,
    coalesce(ts.refresh_token, tf.refresh_token) as token_refresh_token,
    coalesce(ts.access_token, tf.access_token) as token_access_token
  from conta c
  left join lateral (
    select
      t.ml_user_id,
      t.expires_at,
      t.refresh_token,
      t.access_token
    from ml_tokens t
    where t.user_id = c.user_id
      and t.marketplace = c.marketplace
      and c.external_seller_id is not null
      and t.ml_user_id = c.external_seller_id
    order by t.updated_at desc
    limit 1
  ) ts on true
  left join lateral (
    select
      t.ml_user_id,
      t.expires_at,
      t.refresh_token,
      t.access_token
    from ml_tokens t
    where t.user_id = c.user_id
      and t.marketplace = c.marketplace
    order by t.updated_at desc
    limit 1
  ) tf on true
),
classificado as (
  select
    ti.*,
    case
      when ti.token_access_token is null
        or (ti.token_expires_at is not null and ti.token_expires_at <= now() and coalesce(ti.token_refresh_token, '') = '')
        then 'token invalido/ausente'
      when lower(coalesce(ti.competitor_listing_status, '')) in ('not_found', 'closed', 'inactive', 'unavailable')
        then 'anuncio removido/404'
      when lower(coalesce(ti.competitor_listing_status, '')) in ('forbidden', 'under_review')
        then '403 ML'
      when coalesce(ti.raw_snapshot::text, '') ilike '%timeout%'
        then 'timeout'
      else 'erro interno'
    end as causa_provavel
  from token_info ti
),
totais as (
  select count(*)::numeric as total_pendentes
  from classificado
),
top5 as (
  select
    c.causa_provavel,
    c.competitor_listing_id,
    row_number() over (partition by c.causa_provavel order by c.ultima_verificacao_efetiva asc nulls first, c.updated_at asc) as rn
  from classificado c
)
select
  c.causa_provavel,
  count(*)::bigint as quantidade,
  round((count(*)::numeric * 100.0) / nullif(t.total_pendentes, 0), 2) as percentual_sobre_pendentes,
  (
    select string_agg(t5.competitor_listing_id, ', ' order by t5.rn)
    from top5 t5
    where t5.causa_provavel = c.causa_provavel
      and t5.rn <= 5
  ) as exemplos_competitor_listing_id,
  min(c.ultima_verificacao_efetiva) as menor_ultima_verificacao_efetiva
from classificado c
cross join totais t
group by c.causa_provavel, t.total_pendentes
order by quantidade desc, c.causa_provavel;
